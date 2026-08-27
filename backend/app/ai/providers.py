"""Provider-agnostic LLM access.

Two rules govern this module.

1. The model is an interpreter, never a source of fact. It may work out what
   the user meant and phrase a one-line summary. It may not supply a fee, a
   document, an office or a timeline. Those come from verified content and
   are checked by the citation validator regardless of who assembled them.

2. The product must work with no provider configured at all. `NullProvider`
   is not a stub — it is a supported production mode. Retrieval, grounding,
   citation and rendering are all independent of the model, so with no key
   the system still returns correct, cited answers; it just understands
   unusual phrasing less well. That is the reliability story in NFR-3, and
   it is also the clearest demonstration of the grounded-or-silent design.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict
from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx

from ..config import settings

log = logging.getLogger(__name__)

PROMPT_VERSION = "v1.3.0"


@dataclass
class LLMResult:
    data: dict
    provider: str
    model: str
    tokens: int = 0
    ok: bool = True
    error: str = ""


class LLMProvider(ABC):
    name = "base"
    model = ""

    @abstractmethod
    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        ...

    @property
    def available(self) -> bool:
        return True


# A rate limit is a request to wait, not a refusal. On a free tier it is the
# single most common failure, and giving up on the first one throws away an
# answer we could have had by pausing for a second.
#
# But not every rate limit is worth waiting for. A per-MINUTE quota clears in
# under a minute; a per-DAY quota does not clear today. Retrying the second kind
# spends real time to arrive at the same answer, so the two are told apart below.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3


def _describe_http_error(exc: httpx.HTTPStatusError) -> tuple[str, float, bool]:
    """Turn a provider error into something a person can act on.

    Returns (message, retry_after_seconds, worth_retrying).

    Google answers a 429 with the quota that was exceeded, its limit and how
    long to wait - and the previous version of this function discarded all of
    it and reported "429 Too Many Requests", which tells you that something is
    rationed but not what, not how much, and not until when. The specifics were
    in the response body the whole time.
    """
    response = exc.response
    status = response.status_code
    message = f"{status} {response.reason_phrase}"
    retry_after = 0.0
    quota_metric = ""
    quota_value = ""

    try:
        error = (response.json() or {}).get("error") or {}
    except Exception:  # noqa: BLE001 - a body we cannot read is not fatal
        error = {}

    if error.get("message"):
        message = f"{status}: {error['message']}"

    for detail in error.get("details") or []:
        kind = str(detail.get("@type", ""))
        if kind.endswith("QuotaFailure"):
            for violation in detail.get("violations") or []:
                quota_metric = (
                    violation.get("quotaId")
                    or violation.get("quotaMetric")
                    or quota_metric
                )
                quota_value = violation.get("quotaValue") or quota_value
        elif kind.endswith("RetryInfo"):
            raw = str(detail.get("retryDelay", "")).rstrip("s")
            try:
                retry_after = float(raw)
            except ValueError:
                pass

    if not retry_after:
        header = response.headers.get("retry-after")
        try:
            retry_after = float(header) if header else 0.0
        except ValueError:
            retry_after = 0.0

    if quota_metric:
        limit = f", limit {quota_value}" if quota_value else ""
        message = f"{status}: quota '{quota_metric}' exhausted{limit}"

    # A daily allowance does not come back by waiting a few seconds.
    per_day = "per_day" in quota_metric.lower() or "perday" in quota_metric.lower()
    worth_retrying = status in _RETRY_STATUSES and not per_day and retry_after <= 30
    return message, retry_after, worth_retrying


def _with_retries(call, *, log_label: str) -> tuple[dict | None, str]:
    """Run a provider call, retrying transient failures with backoff.

    Returns (data, error). `data` is None when every attempt failed.

    Deliberately short: this sits on the critical path of a person's question,
    so the ceiling on total delay is a couple of seconds. Anything longer and
    the honest move is to fall back to the grounded answer, which is already
    correct and already on its way.
    """
    last_error = ""
    for attempt in range(_MAX_ATTEMPTS):
        try:
            return call(), ""
        except httpx.HTTPStatusError as exc:
            last_error, retry_after, worth_retrying = _describe_http_error(exc)
            if not worth_retrying or attempt == _MAX_ATTEMPTS - 1:
                break
            time.sleep(min(retry_after, 5.0) or 0.6 * (2**attempt))
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            break

    _note_failure(log_label, last_error)
    return None, last_error


# Provider failures come in floods - one rate limit means the next fifty calls
# are rate limited too. Logging each one buries everything else in the terminal
# and tells the reader nothing the first line did not.
_seen_failures: dict[str, int] = {}


def _note_failure(label: str, error: str) -> None:
    key = f"{label}:{error[:60]}"
    count = _seen_failures.get(key, 0) + 1
    _seen_failures[key] = count
    if count == 1:
        log.warning("%s failed: %s", label, error)
        if "quota" in error.lower() and "perday" in error.lower().replace("_", ""):
            log.warning(
                "  ^ this is a DAILY allowance, so it will not clear by waiting. "
                "Answers continue from verified content until it resets. "
                "See https://aistudio.google.com/rate-limit"
            )
    elif count in (5, 25, 100):
        log.warning(
            "%s failed: %s (x%d - falling back to grounded answers each time)",
            label, error, count,
        )


# An identical question asked twice does not need two model calls. Temperature
# is zero everywhere in this system, so the second call would return the same
# object - it would just cost another slice of a daily allowance to do it.
#
# This matters most exactly where the quota hurts: re-running the evaluation
# while tuning, and a demo where the same three questions get typed repeatedly.
# The cache lives in the process, so it is empty on restart and no answer is
# ever served from a previous day.
_CACHE_LIMIT = 512
_cache: "OrderedDict[str, LLMResult]" = OrderedDict()
_cache_stats = {"hits": 0, "misses": 0}


def _cache_key(provider: str, model: str, system: str, user: str) -> str:
    return hashlib.blake2b(
        "\x00".join((provider, model, system, user)).encode("utf-8"), digest_size=16
    ).hexdigest()


def cached_call(provider: LLMProvider, system: str, user: str, schema_hint: str, fetch):
    """Serve a repeated identical call from memory. Only successes are cached:
    a failure is a moment in time, not an answer."""
    key = _cache_key(provider.name, provider.model, system, user)
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
        _cache_stats["hits"] += 1
        return hit

    _cache_stats["misses"] += 1
    result = fetch()
    if result.ok:
        _cache[key] = result
        if len(_cache) > _CACHE_LIMIT:
            _cache.popitem(last=False)
    return result


def cache_stats() -> dict:
    return dict(_cache_stats, size=len(_cache))


def recent_failures() -> list[str]:
    """The distinct provider errors seen in this process, for callers that need
    to decide whether continuing is worth the time."""
    return [key.split(":", 1)[-1] for key in _seen_failures]


class NullProvider(LLMProvider):
    """No model configured. A supported mode, not a failure mode."""

    name = "none"
    model = "deterministic"

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        return LLMResult(data={}, provider=self.name, model=self.model, ok=False,
                         error="no provider configured")


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object in model response")
    return json.loads(text[start : end + 1])


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str, model: str = "") -> None:
        self.api_key = api_key
        self.model = model or "gpt-4o-mini"

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        try:
            resp = httpx.post(
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": f"{system}\n\n{schema_hint}"},
                        {"role": "user", "content": user},
                    ],
                    "response_format": {"type": "json_object"},
                    "max_tokens": settings.llm_max_output_tokens,
                    "temperature": 0,
                },
                timeout=settings.llm_timeout_seconds,
            )
            resp.raise_for_status()
            body = resp.json()
            content = body["choices"][0]["message"]["content"]
            return LLMResult(
                data=_extract_json(content),
                provider=self.name,
                model=self.model,
                tokens=body.get("usage", {}).get("total_tokens", 0),
            )
        except Exception as exc:  # noqa: BLE001 - degrade, never crash the request
            log.warning("openai provider failed: %s", exc)
            return LLMResult({}, self.name, self.model, ok=False, error=str(exc))


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, api_key: str, model: str = "") -> None:
        self.api_key = api_key
        self.model = model or "claude-3-5-haiku-20241022"

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        try:
            resp = httpx.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": self.model,
                    "system": f"{system}\n\n{schema_hint}",
                    "messages": [{"role": "user", "content": user}],
                    "max_tokens": settings.llm_max_output_tokens,
                    "temperature": 0,
                },
                timeout=settings.llm_timeout_seconds,
            )
            resp.raise_for_status()
            body = resp.json()
            content = "".join(part.get("text", "") for part in body.get("content", []))
            usage = body.get("usage", {})
            return LLMResult(
                data=_extract_json(content),
                provider=self.name,
                model=self.model,
                tokens=usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("anthropic provider failed: %s", exc)
            return LLMResult({}, self.name, self.model, ok=False, error=str(exc))


class GeminiProvider(LLMProvider):
    name = "gemini"

    # Model ids are retired on a schedule. gemini-2.0-flash, which this shipped
    # with, has since been shut down: a request to it now 404s and the app
    # quietly falls back to grounded-only, which looks like the model "not
    # working". Run `python -m app.scripts.check_llm` to see the real error.
    DEFAULT_MODEL = "gemini-3.5-flash"

    def __init__(self, api_key: str, model: str = "") -> None:
        self.api_key = api_key
        self.model = model or self.DEFAULT_MODEL

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )

        def once() -> dict:
            # The key travels in a header, never in the query string: a URL
            # ends up in proxy logs, in exception text and in screenshots.
            resp = httpx.post(
                url,
                headers={"x-goog-api-key": self.api_key},
                json={
                    "systemInstruction": {"parts": [{"text": f"{system}\n\n{schema_hint}"}]},
                    "contents": [{"role": "user", "parts": [{"text": user}]}],
                    "generationConfig": {
                        "temperature": 0,
                        "maxOutputTokens": settings.llm_max_output_tokens,
                        "responseMimeType": "application/json",
                    },
                },
                timeout=settings.llm_timeout_seconds,
            )
            resp.raise_for_status()
            return resp.json()

        def fetch() -> LLMResult:
            body, error = _with_retries(once, log_label=f"gemini/{self.model}")
            if body is None:
                return LLMResult({}, self.name, self.model, ok=False, error=error)
            return self._parse(body)

        return cached_call(self, system, user, schema_hint, fetch)

    def _parse(self, body: dict) -> LLMResult:
        try:
            content = body["candidates"][0]["content"]["parts"][0]["text"]
            usage = body.get("usageMetadata", {})
            return LLMResult(
                data=_extract_json(content),
                provider=self.name,
                model=self.model,
                tokens=usage.get("totalTokenCount", 0),
            )
        except Exception as exc:  # noqa: BLE001
            # A truncated or non-JSON body. Usually maxOutputTokens cutting the
            # object off mid-brace, occasionally a safety block with no parts.
            _note_failure(f"gemini/{self.model}", f"unreadable response: {exc}")
            return LLMResult({}, self.name, self.model, ok=False, error=str(exc))


_provider: LLMProvider | None = None


def get_provider() -> LLMProvider:
    global _provider
    if _provider is not None:
        return _provider

    choice = settings.llm_provider
    if choice == "none":
        _provider = NullProvider()
    elif choice in ("auto", "gemini") and settings.gemini_api_key:
        _provider = GeminiProvider(settings.gemini_api_key, settings.llm_model)
    elif choice in ("auto", "openai") and settings.openai_api_key:
        _provider = OpenAIProvider(settings.openai_api_key, settings.llm_model)
    elif choice in ("auto", "anthropic") and settings.anthropic_api_key:
        _provider = AnthropicProvider(settings.anthropic_api_key, settings.llm_model)
    else:
        _provider = NullProvider()

    log.info("LLM provider: %s (%s)", _provider.name, _provider.model)
    return _provider


def reset_provider() -> None:
    """Used by tests and by the admin console after a settings change."""
    global _provider
    _provider = None
