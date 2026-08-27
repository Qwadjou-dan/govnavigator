"""Pluggable embedding layer.

The MVP must work with no API key at all, so the default embedder is local
and deterministic: a hashed character-n-gram + word-n-gram model projected
into a fixed-dimension unit vector. It is not a transformer, and we do not
pretend otherwise — it is a strong lexical-semantic approximation that is
adequate at this corpus size (a few hundred chunks over ~17 services) and
that costs nothing to run.

When an embedding API key is configured the same interface returns real
dense vectors; re-run `python -m app.scripts.ingest --reembed` and the
retrieval layer picks them up with no other change.
"""
from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from abc import ABC, abstractmethod

from ..config import settings

_WORD_RE = re.compile(r"[a-z0-9']+")

# Ghanaian phrasing, abbreviations and Pidgin forms folded to a canonical
# term before anything else happens. This is where "I wan make my business
# proper" starts becoming "register business name".
NORMALISATION_MAP: dict[str, str] = {
    "wan": "want",
    "dey": "is",
    "wetin": "what",
    "abeg": "please",
    "pikin": "child",
    "momo": "mobile money",
    "gh": "ghana",
    "govt": "government",
    "licence": "license",
    "licences": "license",
    "licensing": "license",
    "regd": "registrar",
    "rgd": "registrar general",
    "orc": "registrar of companies",
    "gra": "ghana revenue authority",
    "nia": "national identification authority",
    "dvla": "driver vehicle licensing authority",
    "ssnit": "social security national insurance trust",
    "nhis": "national health insurance",
    "nhia": "national health insurance authority",
    "bdr": "births deaths registry",
    "ama": "accra metropolitan assembly",
    "mmda": "metropolitan municipal district assembly",
    "bop": "business operating permit",
    "tin": "taxpayer identification number",
    "vat": "value added tax",
    "gps": "digital address",
    "ltd": "limited",
    "biz": "business",
    "cert": "certificate",
    "docs": "documents",
    "passpot": "passport",
    "pasport": "passport",
    "bizness": "business",
}


def normalise(text: str) -> str:
    """Lowercase, strip accents, expand Ghanaian shorthand."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    tokens = _WORD_RE.findall(text)
    out: list[str] = []
    for tok in tokens:
        out.append(NORMALISATION_MAP.get(tok, tok))
    return " ".join(out)


def tokenize(text: str) -> list[str]:
    return normalise(text).split()


class BaseEmbedder(ABC):
    name: str = "base"
    dim: int = settings.embedding_dim

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        ...

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]


class LocalHashingEmbedder(BaseEmbedder):
    """Deterministic, dependency-free, offline.

    Features: word unigrams, word bigrams and character 4-grams, each hashed
    into `dim` buckets with a signed hash, sub-linear term weighting, and L2
    normalisation so cosine similarity is a plain dot product.
    """

    name = "local-hashing-v1"

    def __init__(self, dim: int | None = None) -> None:
        self.dim = dim or settings.embedding_dim

    @staticmethod
    def _hash(feature: str) -> tuple[int, float]:
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        value = int.from_bytes(digest, "big")
        sign = 1.0 if value & 1 else -1.0
        return value >> 1, sign

    def _features(self, text: str) -> list[str]:
        tokens = tokenize(text)
        feats: list[str] = list(tokens)
        feats += [f"{a}_{b}" for a, b in zip(tokens, tokens[1:])]
        joined = " ".join(tokens)
        feats += [joined[i : i + 4] for i in range(max(0, len(joined) - 3))]
        return feats

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vec = [0.0] * self.dim
            counts: dict[str, int] = {}
            for feat in self._features(text):
                counts[feat] = counts.get(feat, 0) + 1
            for feat, count in counts.items():
                idx, sign = self._hash(feat)
                vec[idx % self.dim] += sign * (1.0 + math.log(count))
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            vectors.append([v / norm for v in vec])
        return vectors


class OpenAIEmbedder(BaseEmbedder):
    name = "openai-text-embedding-3-small"

    def __init__(self, api_key: str, dim: int) -> None:
        self.api_key = api_key
        self.dim = dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        import httpx

        resp = httpx.post(
            "https://api.openai.com/v1/embeddings",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={
                "model": "text-embedding-3-small",
                "input": texts,
                "dimensions": self.dim,
            },
            timeout=settings.llm_timeout_seconds,
        )
        resp.raise_for_status()
        data = resp.json()["data"]
        return [row["embedding"] for row in sorted(data, key=lambda r: r["index"])]


class GeminiEmbedder(BaseEmbedder):
    """Gemini embeddings, batched.

    Two things here are the result of the same lesson, learned twice. The model
    id is configurable because ids get retired - this shipped pointing at
    `text-embedding-004`, which Google has since shut down, and the only symptom
    was a 404 traceback in the middle of seeding. And the key travels in a
    header rather than the query string, because a URL ends up in tracebacks,
    in terminal scrollback and in whatever chat window someone pastes the error
    into. A key that appears in an error message is a key that has to be
    revoked.
    """

    # Reduced from the model's native 3072 to match `settings.embedding_dim`,
    # which is also the width of the pgvector column. These models are trained
    # so a truncated prefix is still a usable embedding, so this costs a little
    # accuracy and saves a lot of storage.
    DEFAULT_MODEL = "gemini-embedding-2"
    BATCH = 100

    def __init__(self, api_key: str, dim: int, model: str = "") -> None:
        self.api_key = api_key
        self.dim = dim
        self.model = model or self.DEFAULT_MODEL
        self.name = self.model

    def embed(self, texts: list[str]) -> list[list[float]]:
        import httpx

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:batchEmbedContents"
        )
        out: list[list[float]] = []
        # One request per chunk meant 400+ sequential round trips to seed the
        # corpus. Batched, it is a handful.
        for start in range(0, len(texts), self.BATCH):
            window = texts[start : start + self.BATCH]
            resp = httpx.post(
                url,
                headers={"x-goog-api-key": self.api_key},
                json={
                    "requests": [
                        {
                            "model": f"models/{self.model}",
                            "content": {"parts": [{"text": text}]},
                            "outputDimensionality": self.dim,
                        }
                        for text in window
                    ]
                },
                timeout=max(settings.llm_timeout_seconds, 60.0),
            )
            resp.raise_for_status()
            out.extend(row["values"] for row in resp.json()["embeddings"])
        return out


_embedder: BaseEmbedder | None = None


def get_embedder() -> BaseEmbedder:
    global _embedder
    if _embedder is not None:
        return _embedder

    # "auto" means LOCAL, deliberately. Adding a chat key is not consent to
    # change how retrieval works: a remote embedder puts a network call on the
    # critical path of every question, and the vectors it produces are baked
    # into the database, so switching silently would mean the stored vectors
    # and the query vectors came from different models. Ask for it by name.
    choice = settings.embedding_provider
    if choice == "openai" and settings.openai_api_key:
        _embedder = OpenAIEmbedder(settings.openai_api_key, settings.embedding_dim)
    elif choice == "gemini" and settings.gemini_api_key:
        _embedder = GeminiEmbedder(
            settings.gemini_api_key, settings.embedding_dim, settings.embedding_model
        )
    else:
        _embedder = LocalHashingEmbedder()
    return _embedder


def embed_with_fallback(texts: list[str]) -> tuple[list[list[float]], BaseEmbedder, str]:
    """Embed, and if the provider refuses, say why and carry on locally.

    Seeding is the one operation that must not leave someone with nothing. A
    provider outage, a retired model id or a mistyped key used to abort the run
    with a traceback and no database at all - and since the local embedder
    scores identically on the golden set, refusing to build anything was the
    worst of the available options rather than the safest.

    Returns the vectors, the embedder that actually produced them, and a plain
    explanation of any fallback (empty when the chosen embedder worked).
    """
    embedder = get_embedder()
    if not texts or isinstance(embedder, LocalHashingEmbedder):
        return embedder.embed(texts), embedder, ""

    try:
        return embedder.embed(texts), embedder, ""
    except Exception as exc:  # noqa: BLE001 - the point is to keep going
        detail = str(exc)
        if "404" in detail:
            why = (
                f"'{getattr(embedder, 'model', embedder.name)}' was rejected as an unknown "
                "model. Embedding model ids get retired; set EMBEDDING_MODEL in .env to a "
                "current one from https://ai.google.dev/gemini-api/docs/embeddings"
            )
        elif "401" in detail or "403" in detail:
            why = "the API key was rejected - re-copy it from your provider's console"
        elif "429" in detail or "quota" in detail.lower():
            why = "the free-tier rate limit was hit - wait a minute and seed again"
        else:
            why = detail[:200]
        local = LocalHashingEmbedder()
        return local.embed(texts), local, why


def cosine(a: list[float], b: list[float]) -> float:
    """Always returns a plain Python float, never a numpy scalar."""
    if a is None or b is None or len(a) == 0 or len(b) == 0:
        return 0.0
    dot = float(sum(float(x) * float(y) for x, y in zip(a, b)))
    na = math.sqrt(float(sum(float(x) * float(x) for x in a))) or 1.0
    nb = math.sqrt(float(sum(float(y) * float(y) for y in b))) or 1.0
    return dot / (na * nb)
