"""Hybrid retrieval: BM25 keyword search fused with dense vector search.

Why both. Institution names, form numbers and fee labels are keyword-exact
("Form A", "SSNIT", "GH₵130"). User phrasing is semantic ("I want to make my
business proper"). Vector-only search misses the first; keyword-only search
misses the second. Reciprocal-rank fusion over the two is what makes a
national navigator work on real phrasing.

A third signal — alias matching against the curated service registry — is
folded in, because a hand-written alias like "I wan make my business proper"
is the strongest evidence we will ever get about intent.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Chunk, Service
from .embeddings import cosine, get_embedder, normalise, tokenize

log = logging.getLogger("govnavigator")

# Function words carry no intent. Without this list "I want to ..." matches
# every alias that also begins "I want to ...", which is most of them.
STOPWORDS = {
    "i", "a", "an", "the", "to", "for", "of", "my", "me", "you", "your", "we",
    "is", "are", "am", "be", "do", "does", "did", "how", "what", "where", "when",
    "which", "who", "can", "will", "would", "should", "want", "need", "get",
    "go", "going", "make", "in", "on", "at", "it", "this", "that", "and", "or",
    "with", "from", "by", "so", "if", "have", "has", "had", "was", "were",
    "please", "now", "new", "one", "some", "any", "all", "there", "here", "them",
    "dey", "wan", "abeg", "fit", "don", "wetin", "e", "na", "sef", "make",
}


def content_tokens(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in STOPWORDS and len(t) > 1]


@dataclass
class ScoredChunk:
    chunk_id: str
    service_id: str
    source_id: str
    section: str
    text: str
    score: float


@dataclass
class ServiceMatch:
    service_id: str
    name: str
    institution_id: str
    score: float
    bm25: float = 0.0
    dense: float = 0.0
    alias: float = 0.0
    chunks: list[ScoredChunk] = field(default_factory=list)


class BM25Index:
    """Small, self-contained BM25. No external dependency for ~300 chunks."""

    def __init__(self, docs: dict[str, str], k1: float = 1.5, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.doc_tokens = {doc_id: tokenize(text) for doc_id, text in docs.items()}
        self.doc_len = {d: len(t) for d, t in self.doc_tokens.items()}
        self.avg_len = (sum(self.doc_len.values()) / len(self.doc_len)) if self.doc_len else 0.0
        self.df: dict[str, int] = defaultdict(int)
        for tokens in self.doc_tokens.values():
            for term in set(tokens):
                self.df[term] += 1
        self.n = max(1, len(self.doc_tokens))
        self.tf: dict[str, dict[str, int]] = {}
        for doc_id, tokens in self.doc_tokens.items():
            counts: dict[str, int] = defaultdict(int)
            for term in tokens:
                counts[term] += 1
            self.tf[doc_id] = counts

    def _idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        return math.log(1 + (self.n - df + 0.5) / (df + 0.5))

    def search(self, query: str) -> dict[str, float]:
        q_terms = tokenize(query)
        scores: dict[str, float] = defaultdict(float)
        for term in q_terms:
            if term not in self.df:
                continue
            idf = self._idf(term)
            for doc_id, counts in self.tf.items():
                freq = counts.get(term, 0)
                if not freq:
                    continue
                dl = self.doc_len[doc_id]
                denom = freq + self.k1 * (1 - self.b + self.b * dl / (self.avg_len or 1))
                scores[doc_id] += idf * (freq * (self.k1 + 1)) / (denom or 1)
        return dict(scores)


class Retriever:
    """Loads the corpus once per process and serves hybrid queries.

    The corpus is small and read-mostly, so an in-memory index rebuilt on
    demand is both simpler and faster than round-tripping to the database
    per query. `refresh()` is called by the ingest script and by the admin
    console after a curator edits content.
    """

    def __init__(self) -> None:
        self._loaded = False
        self._chunks: dict[str, Chunk] = {}
        self._bm25: BM25Index | None = None
        self._service_meta: dict[str, dict] = {}
        self._alias_index: dict[str, list[str]] = defaultdict(list)

    # -- lifecycle -----------------------------------------------------
    def refresh(self, db: Session) -> None:
        chunks = db.query(Chunk).all()
        services = db.query(Service).all()

        self._chunks = {c.id: c for c in chunks}
        self._bm25 = BM25Index({c.id: c.text for c in chunks}) if chunks else None

        self._service_meta = {
            s.id: {
                "name": s.name,
                "short_name": s.short_name,
                "institution_id": s.institution_id,
                "summary": s.summary,
                "aliases": list(s.aliases or []),
                "keywords": list(s.keywords or []),
                "coverage_tier": s.coverage_tier,
                "clarifiers": list(s.clarifiers or []),
            }
            for s in services
        }

        self._alias_index = defaultdict(list)
        token_services: dict[str, set[str]] = defaultdict(set)
        for sid, meta in self._service_meta.items():
            phrases = [meta["name"], meta["short_name"], *meta["aliases"], *meta["keywords"]]
            for phrase in phrases:
                if phrase:
                    self._alias_index[normalise(phrase)].append(sid)
                    for tok in content_tokens(phrase):
                        token_services[tok].add(sid)

        # A token shared by many services ("business", "ghana") is weak
        # evidence; a token unique to one ("guarantor", "roadworthiness") is
        # strong. Weight accordingly.
        n_services = max(1, len(self._service_meta))
        self._token_weight = {
            tok: math.log(1 + n_services / len(sids)) for tok, sids in token_services.items()
        }

        # Everything the corpus has ever seen. A question full of words that
        # appear nowhere in it ("fishing", "helicopter", "weather") is a
        # question about something we do not cover, however well one of its
        # words happens to match.
        self._vocabulary: set[str] = set(token_services)
        for chunk in chunks:
            self._vocabulary.update(content_tokens(chunk.text))
        self._loaded = True

    def ensure_loaded(self, db: Session) -> None:
        if not self._loaded:
            self.refresh(db)

    @property
    def service_meta(self) -> dict[str, dict]:
        return self._service_meta

    # -- scoring -------------------------------------------------------
    def _alias_scores(self, query: str) -> dict[str, float]:
        """Weighted content-token overlap against curated aliases.

        Only meaningful words count, and rare words count for more, so a
        hand-written alias earns its precision instead of matching every
        sentence that happens to start "I want to".
        """
        q_norm = normalise(query)
        q_tokens = set(content_tokens(query))
        if not q_tokens:
            return {}
        scores: dict[str, float] = defaultdict(float)
        for phrase, service_ids in self._alias_index.items():
            p_tokens = content_tokens(phrase)
            if not p_tokens:
                continue
            total = sum(self._token_weight.get(t, 1.0) for t in set(p_tokens))
            matched = sum(
                self._token_weight.get(t, 1.0) for t in set(p_tokens) if t in q_tokens
            )
            overlap = matched / total if total else 0.0
            # A one-word phrase ("license") is far weaker evidence than a
            # phrase ("renew my driver's licence") and must not alone carry a
            # match past the relevance floor.
            if len(set(p_tokens)) < 2:
                overlap *= 0.5
            # An exact phrase appearing verbatim in the question is the
            # strongest signal available, but only for a phrase with substance.
            if len(p_tokens) >= 2 and phrase in q_norm:
                overlap = 1.0
            if overlap < 0.5:
                continue
            for sid in service_ids:
                scores[sid] = max(scores[sid], overlap)
        return dict(scores)

    def _domain_coverage(self, query: str) -> float:
        """Share of the question's meaningful words the corpus knows at all."""
        # Bare numbers ("2019", "3") are not domain vocabulary and should not
        # count against the question.
        tokens = {t for t in content_tokens(query) if not t.isdigit()}
        if not tokens:
            return 1.0
        known = sum(1 for t in tokens if t in self._vocabulary)
        return known / len(tokens)

    def _dense_scores(self, query: str) -> dict[str, float]:
        embedder = get_embedder()
        try:
            qvec = embedder.embed_one(query)
        except Exception as exc:  # noqa: BLE001
            # A remote embedder is a network call on the critical path of every
            # question. If it fails - rate limit, retired model, expired key -
            # the honest degradation is to answer from BM25 and curated aliases,
            # which is exactly how the product runs with no key at all. Failing
            # the whole question instead would be a self-inflicted outage.
            log.warning("dense retrieval unavailable, using lexical only: %s", exc)
            return {}
        out: dict[str, float] = {}
        for chunk_id, chunk in self._chunks.items():
            embedding = chunk.embedding
            if embedding is None or len(embedding) == 0:
                continue
            out[chunk_id] = cosine(qvec, embedding)
        return out

    @staticmethod
    def _rrf(ranked: list[str], k: int = 60) -> dict[str, float]:
        return {doc: 1.0 / (k + rank + 1) for rank, doc in enumerate(ranked)}

    def service_matches(self, db: Session, service_id: str) -> list[ServiceMatch]:
        """Rebuild the evidence for one service, for a follow-up that names no
        service of its own.

        A sentence like "how much?" scores nothing against the corpus, but in a
        continued conversation it still has a topic. Giving the direct-answer
        model the *continued* service's own chunks keeps that sentence answered
        with evidence instead of with a confusion that then has to be cleaned
        up. The returned match keeps a nominal score so the pipeline's "
        answered from verified content" invariants still hold.
        """
        self.ensure_loaded(db)
        meta = self._service_meta.get(service_id)
        if not meta:
            return []
        chunks = sorted(
            (c for c in self._chunks.values() if c.service_id == service_id),
            key=lambda c: (c.section or "", c.id),
        )
        if not chunks:
            return []
        return [
            ServiceMatch(
                service_id=service_id,
                name=meta["name"],
                institution_id=meta["institution_id"],
                score=1.0,
                chunks=[
                    ScoredChunk(
                        chunk_id=c.id,
                        service_id=c.service_id,
                        source_id=c.source_id,
                        section=c.section,
                        text=c.text,
                        score=1.0,
                    )
                    for c in chunks[:settings.retrieval_top_k]
                ],
            )
        ]

    def search(self, db: Session, query: str, top_k: int | None = None) -> list[ServiceMatch]:
        self.ensure_loaded(db)
        top_k = top_k or settings.retrieval_top_k
        if not self._chunks:
            return []

        bm25_raw = self._bm25.search(query) if self._bm25 else {}
        dense_raw = self._dense_scores(query)

        bm25_rank = self._rrf(sorted(bm25_raw, key=bm25_raw.get, reverse=True))
        dense_rank = self._rrf(sorted(dense_raw, key=dense_raw.get, reverse=True))

        fused: dict[str, float] = defaultdict(float)
        for chunk_id in set(bm25_rank) | set(dense_rank):
            fused[chunk_id] = bm25_rank.get(chunk_id, 0.0) + dense_rank.get(chunk_id, 0.0)

        # Roll chunk evidence up to the service that owns it.
        per_service: dict[str, list[ScoredChunk]] = defaultdict(list)
        for chunk_id, score in fused.items():
            chunk = self._chunks[chunk_id]
            per_service[chunk.service_id].append(
                ScoredChunk(
                    chunk_id=chunk.id,
                    service_id=chunk.service_id,
                    source_id=chunk.source_id,
                    section=chunk.section,
                    text=chunk.text,
                    score=float(score),
                )
            )

        alias = self._alias_scores(query)
        coverage = self._domain_coverage(query)

        matches: list[ServiceMatch] = []
        for service_id, chunk_list in per_service.items():
            meta = self._service_meta.get(service_id)
            if not meta:
                continue
            chunk_list.sort(key=lambda c: c.score, reverse=True)
            # Absolute signals, not signals normalised against the best match.
            # Normalising by the leader would guarantee the top service always
            # scores highly, which makes the relevance floor meaningless and is
            # exactly how a navigator ends up answering questions it should
            # have declined.
            best_bm25 = max((bm25_raw.get(c.chunk_id, 0.0) for c in chunk_list), default=0.0)
            best_dense = max((dense_raw.get(c.chunk_id, 0.0) for c in chunk_list), default=0.0)
            bm25_norm = best_bm25 / (best_bm25 + 9.0)
            alias_score = alias.get(service_id, 0.0)
            combined = 0.34 * bm25_norm + 0.26 * max(0.0, best_dense) + 0.40 * alias_score
            # Damp by how much of the question the corpus recognises, unless a
            # curated alias already identified the intent outright.
            combined *= 0.60 + 0.40 * max(coverage, alias_score)
            matches.append(
                ServiceMatch(
                    service_id=service_id,
                    name=meta["name"],
                    institution_id=meta["institution_id"],
                    score=round(float(combined), 4),
                    bm25=round(float(best_bm25), 3),
                    dense=round(float(best_dense), 3),
                    alias=round(float(alias_score), 3),
                    chunks=chunk_list[:top_k],
                )
            )

        # Services matched only by alias (no chunk cleared the fusion cut).
        seen = {m.service_id for m in matches}
        for service_id, alias_score in alias.items():
            if service_id in seen or service_id not in self._service_meta:
                continue
            meta = self._service_meta[service_id]
            matches.append(
                ServiceMatch(
                    service_id=service_id,
                    name=meta["name"],
                    institution_id=meta["institution_id"],
                    score=round(float(0.40 * alias_score * (0.60 + 0.40 * max(coverage, alias_score))), 4),
                    alias=round(alias_score, 3),
                )
            )

        matches.sort(key=lambda m: m.score, reverse=True)
        return matches


retriever = Retriever()
