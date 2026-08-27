"""The model is allowed to answer the question. It is not allowed to be believed.

Every test here runs the real pipeline against a stub provider that behaves
badly on purpose: inventing fees, citing sources it was never shown, choosing
option values that do not exist. What the person ends up seeing is the subject
of each assertion.

The reason these tests exist is that the direct answer is the one place in the
system where model-written prose reaches a human being. Everywhere else the
model only picks an id. Prose is where a fabrication would be most fluent and
least visible, so the guarantees around it have to be executable, not asserted
in a design document.
"""
from __future__ import annotations

import pytest

from app.ai import pipeline
from app.ai.providers import LLMProvider, LLMResult
from app.db import SessionLocal

QUESTION = "can I get a national ID card for a friend who is abroad"


class StubProvider(LLMProvider):
    """Answers each of the pipeline's calls with whatever the test dictates."""

    name = "stub"
    model = "test"

    def __init__(self, *, conditions: dict | None = None, direct: dict | None = None):
        self._conditions = conditions if conditions is not None else {"settled": {}}
        self._direct = direct or {}
        self.calls: list[str] = []

    def complete_json(self, system: str, user: str, schema_hint: str) -> LLMResult:
        if "still open" in user:
            kind, data = "conditions", self._conditions
        elif "The person asked:" in user:
            kind, data = "direct", self._direct
        elif "Verified service:" in user:
            kind, data = "summary", {"summary": "An orientation line."}
        else:
            kind, data = "intent", {
                "service_id": "ghana-card-registration",
                "confidence": "high",
                "reasoning": "",
                "needs_clarification": False,
                "clarification_topic": None,
                "detected_language": "en",
            }
        self.calls.append(kind)
        return LLMResult(data=data, provider=self.name, model=self.model)


@pytest.fixture
def ask(monkeypatch, seeded):
    def _ask(provider: StubProvider, text: str = QUESTION, **kwargs):
        monkeypatch.setattr(pipeline, "get_provider", lambda: provider)
        with SessionLocal() as db:
            return pipeline.run_query(db, text=text, session_id="test", **kwargs)

    return _ask


# ---------------------------------------------------------------------------
# what it is for
# ---------------------------------------------------------------------------


def test_it_answers_the_question_not_only_the_service(ask):
    """The point of the whole feature: the sentence typed gets a reply."""
    provider = StubProvider(
        conditions={"settled": {"where": "abroad"}},
        direct={
            "question_understood": "Whether they can register a Ghana Card for a friend abroad",
            "verdict": "addressed",
            "answer": "No. Every applicant must appear in person at a designated NIA office "
            "or a Ghana Mission, so nobody can register on your friend's behalf.",
            "source_ids": ["nia-faqs"],
        },
    )
    result = ask(provider)
    answer = result.contract.direct_answer

    assert result.outcome.value == "answered"
    assert answer.verdict.value == "addressed"
    assert "appear in person" in answer.text
    assert answer.source_ids == ["nia-faqs"]


def test_a_condition_in_the_question_is_not_asked_back(ask):
    """"...who is abroad" has already answered the question we were going to ask."""
    provider = StubProvider(conditions={"settled": {"where": "abroad"}})
    result = ask(provider)

    assert result.outcome.value == "answered", "it stopped to ask something already said"
    fee_labels = " ".join(f.label for f in result.contract.fees)
    assert "ECOWAS" in fee_labels, "the in-Ghana fees were shown to someone abroad"

    (assumption,) = result.contract.assumptions
    assert (assumption.id, assumption.value) == ("where", "abroad")
    assert assumption.label == "Outside Ghana"
    assert assumption.origin == "question", "this came from their words, not our default"


def test_the_assumption_is_visible_and_reversible(ask):
    """A wrong assumption must be correctable, so it is shown and can be reopened."""
    reopened = ask(StubProvider(conditions={"settled": {"where": "abroad"}}), reopen="where")

    assert reopened.outcome.value == "clarify"
    assert reopened.clarify.id == "where"


def test_an_explicit_answer_beats_an_inferred_one(ask):
    """If the person chose, their choice is not overridden by the model's reading."""
    provider = StubProvider(conditions={"settled": {"where": "abroad"}})
    result = ask(provider, answers={"where": "in_ghana"})

    fee_labels = " ".join(f.label for f in result.contract.fees)
    assert "ECOWAS" not in fee_labels
    assert "premium centre" in fee_labels


# ---------------------------------------------------------------------------
# what it must never do
# ---------------------------------------------------------------------------


def test_an_uncited_answer_is_destroyed_not_shown(ask):
    """The fabricated fee here is exactly the failure the project exists to prevent."""
    provider = StubProvider(
        conditions={"settled": {"where": "abroad"}},
        direct={
            "question_understood": "x",
            "verdict": "addressed",
            "answer": "Yes. Pay GHS 2,500 at any NIA office and bring your friend's passport.",
            "source_ids": [],
        },
    )
    answer = ask(provider).contract.direct_answer

    assert answer.text == ""
    assert answer.verdict.value == "not_addressed"


def test_citing_a_source_it_was_never_shown_does_not_count(ask):
    """A citation is only a citation if it resolves to evidence we supplied."""
    provider = StubProvider(
        conditions={"settled": {"where": "abroad"}},
        direct={
            "question_understood": "x",
            "verdict": "addressed",
            "answer": "Yes, a relative may register on your behalf.",
            "source_ids": ["wikipedia", "some-blog", "nia-invented"],
        },
    )
    answer = ask(provider).contract.direct_answer

    assert answer.source_ids == []
    assert answer.text == ""
    assert answer.verdict.value == "not_addressed"


def test_a_partly_valid_citation_list_keeps_only_the_valid_part(ask):
    provider = StubProvider(
        conditions={"settled": {"where": "abroad"}},
        direct={
            "question_understood": "x",
            "verdict": "addressed",
            "answer": "Every applicant must appear in person.",
            "source_ids": ["nia-faqs", "definitely-not-a-source"],
        },
    )
    answer = ask(provider).contract.direct_answer

    assert answer.source_ids == ["nia-faqs"]
    assert answer.text  # survives, because one real citation remains


def test_an_invented_option_value_is_discarded(ask):
    """The model picks from a closed set; anything else is not a choice at all."""
    provider = StubProvider(
        conditions={"settled": {"where": "on_the_moon", "no_such_choice": "x"}}
    )
    result = ask(provider)

    values = {a.id: a.value for a in result.contract.assumptions}
    assert "on_the_moon" not in values.values()
    assert "no_such_choice" not in values
    # Nothing usable was read, so the branch falls back to the declared default
    # and is labelled as ours rather than theirs.
    assert values["where"] == "in_ghana"
    assert result.contract.assumptions[0].origin == "default"


def test_a_defaulted_branch_answers_instead_of_interrogating(ask):
    """The common path must not cost a question, but must still be visible."""
    result = ask(StubProvider(), text="how do I get a Ghana Card")

    assert result.outcome.value == "answered"
    (assumption,) = result.contract.assumptions
    assert assumption.origin == "default"
    assert assumption.label == "In Ghana"
    assert assumption.question, "the person must be able to see what was decided for them"


def test_a_branch_with_no_default_still_stops_and_asks(ask):
    """A genuinely even choice is not ours to make."""

    class BusinessStub(StubProvider):
        def complete_json(self, system, user, schema_hint):
            if "still open" in user:
                return LLMResult(data={"settled": {}}, provider="stub", model="test")
            if "The person asked:" in user:
                return LLMResult(data={}, provider="stub", model="test")
            return LLMResult(
                data={
                    "service_id": "business-name-registration",
                    "confidence": "high",
                    "reasoning": "",
                    "needs_clarification": False,
                    "clarification_topic": None,
                    "detected_language": "en",
                },
                provider="stub",
                model="test",
            )

    result = ask(BusinessStub(), text="I want to register my business")

    assert result.outcome.value == "clarify"
    assert result.clarify.id == "structure"


def test_a_broken_verdict_falls_back_to_the_cautious_one(ask):
    provider = StubProvider(
        conditions={"settled": {"where": "abroad"}},
        direct={
            "question_understood": "x",
            "verdict": "definitely-yes-trust-me",
            "answer": "Sure, go ahead.",
            "source_ids": ["nia-faqs"],
        },
    )
    answer = ask(provider).contract.direct_answer

    assert answer.verdict.value == "not_addressed"


def test_a_provider_failure_costs_the_direct_answer_and_nothing_else(ask, monkeypatch):
    """NFR-3: the model is an enhancement. Losing it must not lose the answer."""

    class Broken(StubProvider):
        def complete_json(self, system, user, schema_hint):
            return LLMResult(data={}, provider="stub", model="test", ok=False, error="503")

    result = ask(Broken(), text="how do I get a Ghana Card")

    assert result.outcome.value in {"answered", "clarify"}
    if result.contract:
        assert result.contract.direct_answer is None
        assert result.contract.documents, "the grounded card must survive on its own"


def test_with_no_model_configured_there_is_simply_no_direct_answer(ask):
    """Grounded-only remains a supported mode, not a degraded one."""
    from app.ai.providers import NullProvider

    result = ask(NullProvider(), text="how do I renew my drivers licence")

    assert result.outcome.value == "answered"
    assert result.contract.direct_answer is None
    assert result.contract.documents
    assert result.contract.sources
