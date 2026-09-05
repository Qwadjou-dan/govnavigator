"""Second sentences: the conversation remembers the first.

"One question, one cited answer" is the product's promise, but a person rarely
arrives with a complete sentence. They ask "I want to register my business",
choose "just me", and then type "how much?" — a sentence with no service in it
that still deserves the fee for the branch they chose, not for the other one.

These tests pin the carry-forward rules:

  * a short follow-up below the relevance floor continues the settled service
  * it inherits the branch choices the previous turn resolved (renewal fees do
    not silently become registration fees)
  * a fresh topic is never steered by memory, and a full new sentence is a new
    subject, not a continuation
  * continuing keeps the assembled answer grounded in that service's own sources
"""
from __future__ import annotations

import pytest

from app.ai import pipeline
from app.ai.conversation import ConversationStore, store as global_store
from app.ai.providers import LLMProvider, LLMResult
from app.db import SessionLocal


class StubProvider(LLMProvider):
    """Like the direct-answer stub: honest by default, scriptable per call."""

    name = "stub"
    model = "test"

    def __init__(self, *, conditions: dict | None = None):
        self._conditions = conditions if conditions is not None else {"settled": {}}

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        if "still open" in user:
            return LLMResult(
                data=self._conditions, provider=self.name, model=self.model
            )
        if "The person asked:" in user:
            # For "how much?" style follow-ups the direct-answer model sees the
            # continued service's evidence; claim part of it so the band shows
            # the answer came from a real citation path.
            return LLMResult(
                data={
                    "question_understood": user.split("The person asked:")[-1].strip()[:80],
                    "verdict": "partly_addressed",
                    "answer": "The fee depends on the branch you picked earlier.",
                    "source_ids": [],
                },
                provider=self.name,
                model=self.model,
            )
        if "Verified service:" in user:
            return LLMResult(
                data={"summary": "Registering your business keeps it formal."},
                provider=self.name,
                model=self.model,
            )
        return LLMResult(
            data={
                "service_id": "business-name-registration",
                "confidence": "high",
                "reasoning": "",
                "needs_clarification": False,
                "clarification_topic": None,
                "detected_language": "en",
            },
            provider=self.name,
            model=self.model,
        )


@pytest.fixture
def store():
    """An isolated store per test so one test's turns never leak across."""
    s = ConversationStore(max_sessions=8)
    return s


@pytest.fixture
def ask(monkeypatch, seeded, store):
    monkeypatch.setattr(pipeline, "conversation_store", store)

    def _ask(text: str, session_id: str = "sess-a", **kwargs):
        monkeypatch.setattr(pipeline, "get_provider", lambda: StubProvider())
        with SessionLocal() as db:
            return pipeline.run_query(db, text=text, session_id=session_id, **kwargs)

    return _ask


def _settle_a_business(ask) -> None:
    """Turn 1: ask, get the branch question, answer it as a sole owner."""
    first = ask("I want to register my business")
    assert first.outcome.value == "clarify"
    assert first.service_id == "business-name-registration"

    settled = ask("I want to register my business", answers={"structure": "sole"})
    assert settled.outcome.value == "answered"
    assert settled.service_id == "business-name-registration"


def test_short_followup_continues_the_settled_service(ask):
    _settle_a_business(ask)

    follow = ask("how much?")
    assert follow.outcome.value == "answered"
    assert follow.service_id == "business-name-registration"
    # The continuation is legible, not a hidden guess.
    stages = {s["stage"] for s in follow.stages}
    assert "continue" in stages


def _settle_a_card(ask) -> None:
    """Turn 1: resolve the Ghana Card question onto the 'abroad' branch."""
    first = ask("I want to register for a Ghana Card")
    assert first.outcome.value == "answered"
    assert first.service_id == "ghana-card-registration"

    # Force the branch explicitly so there is a settled choice to carry.
    settled = ask("I want to register for a Ghana Card", answers={"where": "abroad"})
    assert settled.outcome.value == "answered"
    docs = [d.name for d in settled.contract.documents]
    assert any("booked registration appointment" in d.lower() for d in docs)


def test_followup_stays_on_the_branch_that_was_chosen(ask):
    _settle_a_card(ask)

    follow = ask("ok so how much and what docs")
    assert follow.outcome.value == "answered"
    assert follow.service_id == "ghana-card-registration"
    # The carried branch choice means the follow-up card still assembles the
    # abroad documents, not silently falling back to the in-Ghana ones.
    names = [d.name for d in follow.contract.documents]
    assert any("booked registration appointment" in d.lower() for d in names)
    assert not any("digital address code" in d.lower() for d in names)


def test_memory_never_overrides_a_real_weak_match(ask):
    """"what documents do I need?" scores above the floor against passport.
    Memory must not override that: a real match, however weak, wins over a
    guess from context. The wrong-answer recovery in the thread is the tool
    for correcting it — not silent re-routing by the backend."""
    _settle_a_business(ask)

    follow = ask("what documents do I need")
    stages = {s["stage"] for s in follow.stages}
    assert "continue" not in stages
    assert follow.service_id == "passport-first-time"


def test_a_fresh_short_topic_is_not_steered_by_memory(ask):
    """Memory must never reach across topics. "passport" is a clear new subject
    even though it is only one word — retrieval finds it, so continuation is
    never even considered."""
    _settle_a_business(ask)

    fresh = ask("passport")
    stages = {s["stage"] for s in fresh.stages}
    assert "continue" not in stages
    assert fresh.service_id != "business-name-registration"


def test_a_full_sentence_is_a_new_topic_even_when_unmatched(ask):
    """A genuine new topic that fails retrieval must still be refused, not
    silently chained to the previous service. The word-length bar keeps the
    probe honest: continuation is for fragments, not for sentences."""
    _settle_a_business(ask)

    other = ask("I need help locating my father's name files from overseas")
    assert other.outcome.value == "refused"


def test_new_session_gets_no_continuation(ask):
    # Turn 1 on session A settles. Turn 1 on session B is a fresh fragment.
    _settle_a_business(ask)

    first_b = ask("how much?", session_id="sess-b")
    assert first_b.outcome.value == "refused"