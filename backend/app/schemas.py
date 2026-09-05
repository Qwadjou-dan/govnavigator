"""The Answer Contract and the API request/response models.

The Answer Contract is the heart of this system. The language model never
writes the text a user reads: it fills in this object, a validator checks
every populated field against its citation, and the interface renders the
validated result. Prose is not the transport, so fluency cannot smuggle in
a fact that no official source supports.
"""
from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class FieldStatus(str, Enum):
    """Why a field looks the way it does.

    `NOT_PUBLISHED` is the important one and the reason this enum exists.
    Several Ghanaian agencies genuinely do not publish processing times or
    fee amounts. The honest rendering of that is "the institution does not
    publish this", not a plausible-looking number.
    """

    CONFIRMED = "confirmed"                    # official source states it
    SECONDARY = "secondary"                    # only a non-official source states it
    NOT_PUBLISHED = "not_published"            # the institution publishes no figure
    VARIES_BY_LOCALITY = "varies_by_locality"  # e.g. every assembly sets its own fee
    DISPUTED = "disputed"                      # official sources contradict each other


class Confidence(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Freshness(str, Enum):
    FRESH = "fresh"
    VERIFY = "verify"
    STALE = "stale"


class Outcome(str, Enum):
    ANSWERED = "answered"
    CLARIFY = "clarify"
    REFUSED = "refused"
    BLOCKED = "blocked"      # out of scope: legal/tax advice, circumvention


# ---------------------------------------------------------------------------
# Contract parts
# ---------------------------------------------------------------------------


class SourceRef(BaseModel):
    id: str
    title: str
    publisher: str
    url: str
    is_official: bool = True
    retrieved_at: date | None = None
    effective_date: date | None = None
    note: str = ""


class InstitutionOut(BaseModel):
    id: str
    name: str
    abbreviation: str = ""
    mandate: str = ""
    official_url: str = ""
    portal_url: str = ""
    phone: str = ""
    email: str = ""
    head_office: str = ""
    digital_address: str = ""
    opening_hours: str = ""
    offices: list[str] = Field(default_factory=list)
    coverage_tier: int = 2


class EligibilityItem(BaseModel):
    text: str
    applies_to: str = "everyone"
    status: FieldStatus = FieldStatus.CONFIRMED
    source_ref: str | None = None


class DocumentItem(BaseModel):
    name: str
    mandatory: bool = True
    where_to_obtain: str = ""
    note: str = ""
    one_of_group: str | None = None   # "provide any one of these"
    status: FieldStatus = FieldStatus.CONFIRMED
    source_ref: str | None = None


class StepItem(BaseModel):
    order: int
    action: str
    channel: Literal["online", "in_person", "either", "phone", "ussd"] = "either"
    location: str = ""
    note: str = ""
    status: FieldStatus = FieldStatus.CONFIRMED
    source_ref: str | None = None


class FeeItem(BaseModel):
    label: str
    amount_ghs: float | None = None
    amount_text: str | None = None      # for USD-equivalent or banded fees
    effective_date: date | None = None
    status: FieldStatus = FieldStatus.CONFIRMED
    note: str = ""
    source_ref: str | None = None


class TimelineOut(BaseModel):
    standard: str | None = None
    expedited: str | None = None
    status: FieldStatus = FieldStatus.CONFIRMED
    note: str = ""
    source_ref: str | None = None


class RejectionCause(BaseModel):
    text: str
    evidence_level: Literal["official", "secondary", "inferred"] = "inferred"
    source_ref: str | None = None


class RelatedService(BaseModel):
    id: str
    name: str
    institution: str
    reason: str = ""


class Caveat(BaseModel):
    kind: Literal["freshness", "coverage", "eligibility", "dispute", "locality", "scope"]
    text: str


class ValidatorReport(BaseModel):
    """What the guardrail layer did. Surfaced in the API and the admin
    console so quality is observable rather than asserted."""

    fields_checked: int = 0
    fields_dropped: int = 0
    dropped: list[str] = Field(default_factory=list)
    unsourced_claims: int = 0
    strict_fields_ok: bool = True
    notes: list[str] = Field(default_factory=list)


class DirectAnswerVerdict(str, Enum):
    """Whether the verified content actually answers what was asked.

    NOT_ADDRESSED is the point of this enum. A person who asks "can I do this
    for someone else, from abroad?" and receives a generic checklist has been
    answered in form and ignored in substance. Saying "our sources set out X
    but do not cover your situation" is a real answer; a checklist that quietly
    assumes a different situation is not.
    """

    ADDRESSED = "addressed"                # the sources answer the question put
    PARTLY_ADDRESSED = "partly_addressed"  # they answer part of it
    NOT_ADDRESSED = "not_addressed"        # they do not cover this situation


class DirectAnswer(BaseModel):
    """A short, cited reply to the question actually asked.

    Written by the model, but only ever from retrieved passages, and passed
    through the same citation validator as every other field: text whose
    citations do not resolve is dropped rather than shown. `question_understood`
    is displayed so a misreading is visible to the person rather than silent.
    """

    question_understood: str = ""
    verdict: DirectAnswerVerdict = DirectAnswerVerdict.NOT_ADDRESSED
    text: str = ""
    source_ids: list[str] = Field(default_factory=list)


class Assumption(BaseModel):
    """Something the answer took as given without the person confirming it.

    Where a service branches - registering here or at a mission abroad, a sole
    trader or a limited company - the branch has to be chosen before there is
    anything to show. Asking every time costs a tap on the common path;
    choosing silently is worse, because a person reading fees for a situation
    that is not theirs has no way to tell. So we choose, then say we chose, and
    make it one click to disagree.

    `origin` distinguishes a condition read out of the person's own words from
    one we simply defaulted to, because the second deserves more scepticism
    from the reader than the first.
    """

    id: str
    value: str
    label: str                                  # the chosen option, in words
    question: str                               # what it stands in for
    origin: Literal["question", "default"] = "default"


class AnswerContract(BaseModel):
    """The only shape an answer can take."""

    outcome: Outcome
    intent: str | None = None
    service_id: str | None = None
    service_name: str | None = None
    summary: str = ""
    coverage_tier: int | None = None
    confidence: Confidence = Confidence.LOW
    freshness: Freshness = Freshness.FRESH

    # Answers the question that was asked, before the service card that follows
    # answers the service it belongs to. None when no model is configured.
    direct_answer: DirectAnswer | None = None
    # Branch choices made on the person's behalf, shown so they can disagree.
    assumptions: list[Assumption] = Field(default_factory=list)

    institution: InstitutionOut | None = None
    dependent_institutions: list[InstitutionOut] = Field(default_factory=list)

    eligibility: list[EligibilityItem] = Field(default_factory=list)
    documents: list[DocumentItem] = Field(default_factory=list)
    steps: list[StepItem] = Field(default_factory=list)
    fees: list[FeeItem] = Field(default_factory=list)
    timeline: TimelineOut | None = None
    common_rejection_causes: list[RejectionCause] = Field(default_factory=list)
    related_services: list[RelatedService] = Field(default_factory=list)

    sources: list[SourceRef] = Field(default_factory=list)
    caveats: list[Caveat] = Field(default_factory=list)

    last_reviewed_by_team: date | None = None
    content_version: int = 1
    generated_by: str = "grounded-assembler"
    prompt_version: str = ""
    validator: ValidatorReport = Field(default_factory=ValidatorReport)


class ClarifyOption(BaseModel):
    value: str
    label: str
    hint: str = ""


class ClarifyQuestion(BaseModel):
    id: str
    question: str
    options: list[ClarifyOption] = Field(default_factory=list)
    allow_skip: bool = True


class CandidateService(BaseModel):
    id: str
    name: str
    institution: str
    score: float
    summary: str = ""


# ---------------------------------------------------------------------------
# API surface
# ---------------------------------------------------------------------------


class QueryRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    session_id: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)
    service_id: str | None = None   # user explicitly picked a candidate
    skip_clarification: bool = False
    # A condition the person wants put back to them, because the one we read
    # out of their question was wrong. Never re-inferred on this pass.
    reopen: str | None = None


class QueryResponse(BaseModel):
    query_id: str
    answer_id: str | None = None
    session_id: str
    outcome: Outcome
    contract: AnswerContract | None = None
    clarify: ClarifyQuestion | None = None
    # Present on clarify responses too, so the interface can show what we
    # think you mean while we ask, instead of a blank screen with a question.
    service_id: str | None = None
    service_name: str | None = None
    candidates: list[CandidateService] = Field(default_factory=list)
    message: str = ""
    suggested_institution: InstitutionOut | None = None
    latency_ms: int = 0
    stages: list[dict] = Field(default_factory=list)


class FeedbackRequest(BaseModel):
    answer_id: str | None = None
    service_id: str | None = None
    verdict: Literal["yes", "partly", "no"]
    comment: str = Field(default="", max_length=2000)


class EscalationRequest(BaseModel):
    """A person asking to be put in touch with a human about a specific card.

    Deliberately tiny: the query text is what the backlog ranks on, and the
    institution is who should see it. Everything else is noise for a curator.
    """

    query_text: str = Field(default="", max_length=1000)
    service_id: str | None = None
    institution_id: str | None = None
    outcome: str = "answered"


class RequestCodeRequest(BaseModel):
    contact: str = Field(min_length=3, max_length=255)


class VerifyCodeRequest(BaseModel):
    contact: str
    code: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str = "citizen"
    label: str = ""


class SaveChecklistRequest(BaseModel):
    service_id: str
    title: str
    payload: dict = Field(default_factory=dict)
    progress: dict = Field(default_factory=dict)


class ChecklistOut(BaseModel):
    id: str
    service_id: str
    title: str
    payload: dict
    progress: dict
    updated_at: str
