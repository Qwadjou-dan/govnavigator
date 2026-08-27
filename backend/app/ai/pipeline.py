"""The orchestrator: ten stages from a sentence to a validated answer.

    1  intake            normalise, strip identifiers, neutralise injection
    2  scope gate        refuse advice / circumvention before anything else
    3  retrieval         hybrid BM25 + dense over the grounded corpus
    4  intent            model-assisted where available, retrieval-led otherwise
    5  disambiguation    ask at most one question when the field is close
    6  eligibility       branch on the answers already given
    7  assembly          fill the Answer Contract from verified content only
    8  validation        drop every field without a resolvable citation
    9  freshness         flag anything older than policy
    10 respond + learn   log the trace, record Tier 3 misses

Stage 3 runs before stage 4 deliberately. Retrieval evidence makes the intent
decision better and gives the pipeline a working answer even when no model is
configured at all.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from ..config import settings
from ..models import CoverageRequest, Institution, QueryLog, AnswerLog, Service
from ..schemas import (
    Assumption,
    CandidateService,
    ClarifyOption,
    ClarifyQuestion,
    DirectAnswer,
    DirectAnswerVerdict,
    InstitutionOut,
    Outcome,
    QueryResponse,
)
from . import guardrails
from .assembler import _by_id, _institution_out, build_contract
from .embeddings import normalise
from .prompts import (
    CONDITIONS_SCHEMA_HINT,
    CONDITIONS_SYSTEM,
    DIRECT_ANSWER_SCHEMA_HINT,
    DIRECT_ANSWER_SYSTEM,
    EVIDENCE_PREAMBLE,
    INTENT_SCHEMA_HINT,
    INTENT_SYSTEM,
    SUMMARY_SCHEMA_HINT,
    SUMMARY_SYSTEM,
)
from .providers import PROMPT_VERSION, get_provider
from .retrieval import ServiceMatch, content_tokens, retriever

REFUSAL_TEMPLATE = (
    "We could not confirm this from an official source, so we would rather not guess — "
    "a wrong requirement could cost you a wasted trip."
)

# A refusal may still offer near misses, but only genuine ones. Every question
# scores against something, so taking the top three unconditionally offered
# "Birth certificate" to someone asking about importing a helicopter — which
# reads as the system flailing and undermines the refusal it sits beneath.
# Out-of-corpus questions land around 0.17-0.24 and real near misses above 0.30.
SUGGESTION_FLOOR = 0.30

# When retrieval is this confident, and this far ahead of the runner-up, the
# intent model call is skipped. Both thresholds sit well above the relevance
# floor (0.45) and the ambiguity margin (0.04), so a question only takes this
# path when there was nothing left to decide.
DECISIVE_SCORE = 0.62
DECISIVE_MARGIN = 0.15


@dataclass
class Trace:
    """A visible record of what the pipeline did. Surfaced to the UI so the
    grounding is legible to the user rather than magical."""

    stages: list[dict] = field(default_factory=list)

    def add(self, name: str, detail: str, **extra) -> None:
        self.stages.append({"stage": name, "detail": detail, **extra})


def run_query(
    db: Session,
    *,
    text: str,
    session_id: str | None = None,
    answers: dict[str, str] | None = None,
    forced_service_id: str | None = None,
    skip_clarification: bool = False,
    reopen: str | None = None,
) -> QueryResponse:
    started = time.perf_counter()
    session_id = session_id or uuid.uuid4().hex
    answers = answers or {}
    trace = Trace()
    provider = get_provider()

    # -- 1. intake ------------------------------------------------------
    cleaned, redacted = guardrails.strip_identifiers(text)
    cleaned = guardrails.neutralise_injection(cleaned)
    normalised = normalise(cleaned)
    if redacted:
        trace.add(
            "intake",
            "Removed something that looked like an ID number before storing or sending anything.",
            redacted=redacted,
        )
    else:
        trace.add("intake", "Question received and normalised.")

    # -- 2. scope gate --------------------------------------------------
    if guardrails.is_out_of_scope(cleaned):
        trace.add("scope", "Out of scope: advice or circumvention.")
        query_id = _log(
            db, session_id, cleaned, normalised, "blocked", None, None, None, None,
            [], provider, {}, started,
        )
        return QueryResponse(
            query_id=query_id,
            session_id=session_id,
            outcome=Outcome.BLOCKED,
            message=guardrails.BLOCK_MESSAGE,
            latency_ms=_elapsed(started),
            stages=trace.stages,
        )

    # -- 3. retrieval ---------------------------------------------------
    matches = retriever.search(db, cleaned)
    top_score = matches[0].score if matches else 0.0
    trace.add(
        "retrieval",
        f"Searched the grounded corpus and found {len(matches)} candidate services.",
        top_score=round(top_score, 3),
    )

    # -- 4. intent ------------------------------------------------------
    chosen_id = forced_service_id
    if chosen_id is None:
        chosen_id, intent_note = _resolve_intent(cleaned, matches, provider)
        trace.add("intent", intent_note)
    else:
        trace.add("intent", "You chose this service from the list.")

    # -- Tier 3: nothing clears the floor -------------------------------
    # The floor exists to stop *us* guessing. It was never meant to overrule a
    # person who has told us plainly which service they want: when someone picks
    # from the list on a refusal card, their own words scored below the floor by
    # definition, so re-applying it here sends them straight back to the same
    # refusal. That made every suggestion on that card a dead end.
    if forced_service_id is None and (chosen_id is None or top_score < settings.relevance_floor):
        return _refuse(db, session_id, cleaned, normalised, matches, provider, trace, started)

    service = db.get(Service, chosen_id) if chosen_id else None
    if service is None:
        return _refuse(db, session_id, cleaned, normalised, matches, provider, trace, started)

    # Say so plainly rather than quietly pretending we found this ourselves.
    # The card is still built only from verified, cited content — what changed
    # is who chose it, and the audit trail should show that.
    if forced_service_id is not None and top_score < settings.relevance_floor:
        trace.add(
            "relevance",
            "Our own search did not confidently match your words to this service — "
            "you chose it. Everything below is still verified and cited.",
            top_score=round(top_score, 3),
        )

    # -- 5. disambiguation ----------------------------------------------
    if not skip_clarification and forced_service_id is None and len(matches) > 1:
        runner_up = matches[1]
        # The margin scales with how uncertain we actually are, rather than
        # being a fixed gap between two numbers.
        #
        # A fixed gap punishes any pair of services that share a domain: "file
        # my VAT return" and "register for VAT" are different services with
        # almost identical vocabulary, so they sat 0.03 apart and the app asked
        # a question whose answer was already in the sentence. But the same 0.03
        # between two weak matches is real doubt. Scaling by (1 - top) says: the
        # more confident the leader, the smaller the gap it needs to be trusted.
        margin = settings.ambiguity_margin * (1.0 - matches[0].score)
        if matches[0].score - runner_up.score < margin:
            trace.add(
                "clarify",
                "Two services are close enough that guessing would be irresponsible.",
            )
            candidates = _candidates(db, matches[:3])
            query_id = _log(
                db, session_id, cleaned, normalised, "clarify", None, None, None,
                top_score, [], provider, {}, started,
            )
            return QueryResponse(
                query_id=query_id,
                session_id=session_id,
                outcome=Outcome.CLARIFY,
                candidates=candidates,
                clarify=ClarifyQuestion(
                    id="which_service",
                    question="Which of these are you trying to do?",
                    options=[
                        ClarifyOption(value=c.id, label=c.name, hint=c.institution)
                        for c in candidates
                    ],
                ),
                service_id=matches[0].service_id,
                service_name=matches[0].name,
                message="More than one service matches what you described.",
                latency_ms=_elapsed(started),
                stages=trace.stages,
            )

    # -- 6. eligibility branching ---------------------------------------
    # Before asking, check whether the question already answered us. Someone who
    # wrote "for a friend who is abroad" has said where they are; stopping to
    # ask is the machine failing to listen to words it was given.
    read_from_question = _conditions_from_question(
        cleaned, service, answers, provider, reopen
    )
    # Anything the person chose outright always wins over anything we worked out.
    answers = {**read_from_question, **answers}

    # A branch with a declared default does not stop the answer. Guessing in
    # silence would be wrong, but so is charging every person a question to
    # serve the rare case; we take the common path, say we took it, and make
    # it one click to disagree.
    defaults = _defaults_for(service, answers, reopen)
    answers = {**defaults, **answers}

    assumptions = _describe_assumptions(service, read_from_question, defaults)
    if assumptions:
        trace.add(
            "conditions",
            "; ".join(
                f"Took \"{a.label}\" "
                + ("from your own words" if a.origin == "question" else "as the usual case")
                for a in assumptions
            ),
            assumed={a.id: a.value for a in assumptions},
        )

    pending = _pending_clarifier(service, answers)
    if pending and not skip_clarification:
        trace.add("clarify", "One detail changes the requirements, so we ask before answering.")
        query_id = _log(
            db, session_id, cleaned, normalised, "clarify", service.id,
            service.coverage_tier, None, top_score, [], provider, {}, started,
        )
        return QueryResponse(
            query_id=query_id,
            session_id=session_id,
            outcome=Outcome.CLARIFY,
            service_id=service.id,
            service_name=service.name,
            clarify=ClarifyQuestion(
                id=pending["id"],
                question=pending["question"],
                options=[
                    ClarifyOption(
                        value=o["value"], label=o["label"], hint=o.get("hint", "")
                    )
                    for o in pending.get("options", [])
                ],
            ),
            message="",
            latency_ms=_elapsed(started),
            stages=trace.stages,
        )

    # -- 7. assembly ----------------------------------------------------
    # The direct answer is worth a round trip; a rephrased orientation line is
    # not worth a second one on top of it. When we are going to answer the
    # question directly, the curated summary stays as written and the model's
    # single call goes on the part the person actually asked about.
    direct = _direct_answer(cleaned, matches, provider)
    summary = None if direct is not None else _summary(cleaned, service, db, provider)

    contract = build_contract(
        db,
        service,
        summary_override=summary,
        generated_by=("llm-assisted" if provider.name != "none" else "grounded-assembler"),
        prompt_version=PROMPT_VERSION,
        eligibility_filter=answers,
    )
    trace.add(
        "assembly",
        "Filled the answer from verified content. The model never supplies a fee, "
        "document or timeline.",
    )

    # -- 7b. answer the question, not just the service -------------------
    contract.assumptions = assumptions
    if direct is not None:
        contract.direct_answer = direct
        trace.add(
            "direct_answer",
            {
                "addressed": "The verified sources answer what you asked.",
                "partly_addressed": "The verified sources answer part of what you asked.",
                "not_addressed": "The verified sources do not cover your situation, and "
                "we say so rather than showing you a checklist that assumes otherwise.",
            }[direct.verdict.value],
            verdict=direct.verdict.value,
            cited=direct.source_ids,
        )

    # -- 8/9. validation and freshness ran inside build_contract ---------
    trace.add(
        "validation",
        f"Checked {contract.validator.fields_checked} fields against their citations; "
        f"dropped {contract.validator.fields_dropped}.",
        dropped=contract.validator.dropped,
    )
    trace.add("freshness", f"Freshness: {contract.freshness.value}.")

    # -- 10. respond and learn ------------------------------------------
    chunk_ids = [c.chunk_id for m in matches[:1] for c in m.chunks]
    query_id = _log(
        db, session_id, cleaned, normalised, "answered", service.id,
        service.coverage_tier, contract.confidence.value, top_score, chunk_ids,
        provider, contract.validator.model_dump(), started,
    )
    answer = AnswerLog(
        query_id=query_id,
        service_id=service.id,
        contract=contract.model_dump(mode="json"),
        content_version=service.content_version,
    )
    db.add(answer)
    db.commit()

    return QueryResponse(
        query_id=query_id,
        answer_id=answer.id,
        session_id=session_id,
        outcome=Outcome.ANSWERED,
        service_id=service.id,
        service_name=service.name,
        contract=contract,
        candidates=_candidates(db, matches[1:4]),
        latency_ms=_elapsed(started),
        stages=trace.stages,
    )


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _elapsed(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _resolve_intent(text: str, matches: list[ServiceMatch], provider) -> tuple[str | None, str]:
    """Retrieval proposes, the model disposes — and only among candidates."""
    if not matches:
        return None, "Nothing in the knowledge base matched this question."

    top = matches[0]
    if provider.name == "none":
        return top.service_id, (
            "Matched by hybrid search over official content (no language model configured, "
            "so answers still come from verified sources)."
        )

    # Do not spend a model call on a question retrieval has already answered.
    # When one service scores well clear of the floor and well clear of the
    # runner-up, there is nothing for the model to disambiguate - and on a free
    # tier, every avoidable call is one that could have been the rate limit for
    # a call that mattered. This is also the difference between two model calls
    # per question and three.
    runner_up = matches[1].score if len(matches) > 1 else 0.0
    if top.score >= DECISIVE_SCORE and top.score - runner_up >= DECISIVE_MARGIN:
        return top.service_id, (
            "Matched by hybrid search over official content, clearly enough that "
            "asking the model would not have changed the answer."
        )

    candidate_lines = "\n".join(
        f"- {m.service_id}: {m.name}" for m in matches[:6]
    )
    result = provider.complete_json(
        INTENT_SYSTEM,
        f"Person's goal: {text}\n\nCandidate services:\n{candidate_lines}",
        INTENT_SCHEMA_HINT,
    )
    if not result.ok:
        return top.service_id, (
            "Language model unavailable, so the match came from hybrid search over "
            "official content."
        )

    picked = result.data.get("service_id")
    valid = {m.service_id for m in matches[:6]}
    if picked in valid:
        return picked, f"Understood as: {result.data.get('reasoning', 'matched to a known service')}"
    if picked is None:
        return None, "The model could not map this to any service we cover."
    # The model named something outside the candidate list. Ignore it.
    return top.service_id, "Model suggestion discarded (not in the candidate list); used search ranking."


def _summary(text: str, service: Service, db: Session, provider) -> str | None:
    if provider.name == "none":
        return None
    inst = db.get(Institution, service.institution_id)
    result = provider.complete_json(
        SUMMARY_SYSTEM,
        (
            f"Person asked: {text}\n"
            f"Verified service: {service.name}\n"
            f"Responsible institution: {inst.name if inst else 'unknown'}"
        ),
        SUMMARY_SCHEMA_HINT,
    )
    if not result.ok:
        return None
    summary = (result.data.get("summary") or "").strip()
    # A summary is not allowed to contain facts. If it looks like it does,
    # discard it and fall back to curated text rather than police it.
    if not summary or any(ch.isdigit() for ch in summary) or "GH" in summary:
        return None
    return summary[:240]


def _conditions_from_question(
    text: str,
    service: Service,
    answers: dict[str, str],
    provider,
    reopen: str | None = None,
) -> dict[str, str]:
    """Read clarifier answers out of the question itself.

    The model chooses from a closed set of option values declared in the
    content, and anything it returns that is not in that set is discarded. It
    therefore cannot invent a condition; the worst it can do is pick the wrong
    one of the offered branches, which the person can see and correct because
    the assumption is shown on the card.
    """
    if provider.name == "none":
        return {}
    # A condition the person has just told us we got wrong is never inferred
    # again on the same breath - it goes back to them as a question.
    open_choices = [
        c
        for c in (service.clarifiers or [])
        if c["id"] not in answers and c["id"] != reopen
    ]
    if not open_choices:
        return {}

    described = "\n".join(
        f"- id \"{c['id']}\": {c['question']}\n"
        + "\n".join(
            f"    value \"{o['value']}\" means {o['label']}"
            + (f" ({o['hint']})" if o.get("hint") else "")
            for o in c.get("options", [])
        )
        for c in open_choices
    )
    result = provider.complete_json(
        CONDITIONS_SYSTEM,
        f"Question: {text}\n\nChoices that are still open:\n{described}",
        CONDITIONS_SCHEMA_HINT,
    )
    if not result.ok:
        return {}

    permitted = {
        c["id"]: {o["value"] for o in c.get("options", [])} for c in open_choices
    }
    settled = result.data.get("settled")
    if not isinstance(settled, dict):
        return {}
    return {
        key: value
        for key, value in settled.items()
        if key in permitted
        and isinstance(value, str)
        and value in permitted[key]
    }


def _defaults_for(
    service: Service, answers: dict[str, str], reopen: str | None
) -> dict[str, str]:
    """Fill in branches that declare a usual case and have not been answered.

    A clarifier without a `default` still stops and asks - that is how a
    genuinely even choice (sole trader or limited company) is meant to behave.
    """
    return {
        clar["id"]: clar["default"]
        for clar in (service.clarifiers or [])
        if clar.get("default")
        and clar["id"] not in answers
        and clar["id"] != reopen
    }


def _describe_assumptions(
    service: Service, from_question: dict[str, str], defaults: dict[str, str]
) -> list[Assumption]:
    """Put every unconfirmed branch choice into words the reader can check.

    An assumption nobody can see is indistinguishable from a mistake nobody
    can correct.
    """
    origins = {**{k: "default" for k in defaults}, **{k: "question" for k in from_question}}
    out: list[Assumption] = []
    for clar in service.clarifiers or []:
        chosen = origins.get(clar["id"])
        if not chosen:
            continue
        value = from_question.get(clar["id"]) or defaults.get(clar["id"], "")
        label = next(
            (o["label"] for o in clar.get("options", []) if o["value"] == value), value
        )
        out.append(
            Assumption(
                id=clar["id"],
                value=value,
                label=label,
                question=clar["question"],
                origin=chosen,
            )
        )
    return out


def _direct_answer(
    text: str,
    matches: list[ServiceMatch],
    provider,
) -> DirectAnswer | None:
    """A short cited reply to the question, or None when no model is configured.

    Two things keep this honest. The model sees only retrieved passages, and it
    must name the source ids it used; ids that are not among the passages it was
    shown are dropped, and an answer left with no surviving citation is thrown
    away entirely rather than shown uncited. That is the same rule the rest of
    the contract lives under - it is just applied to prose here.
    """
    if provider.name == "none":
        return None

    chunks = [c for m in matches[:2] for c in m.chunks[:6]]
    if not chunks:
        return None
    offered = {c.source_id for c in chunks if c.source_id}
    evidence = "\n\n".join(
        f"<evidence source_id=\"{c.source_id}\" section=\"{c.section}\">\n{c.text}\n</evidence>"
        for c in chunks
    )

    result = provider.complete_json(
        DIRECT_ANSWER_SYSTEM,
        f"{EVIDENCE_PREAMBLE}\n\n{evidence}\n\nThe person asked: {text}",
        DIRECT_ANSWER_SCHEMA_HINT,
    )
    if not result.ok:
        return None

    answer = (result.data.get("answer") or "").strip()
    cited = [
        sid
        for sid in (result.data.get("source_ids") or [])
        if isinstance(sid, str) and sid in offered
    ]
    verdict_raw = result.data.get("verdict")
    try:
        verdict = DirectAnswerVerdict(verdict_raw)
    except ValueError:
        verdict = DirectAnswerVerdict.NOT_ADDRESSED

    # Prose with nothing behind it is exactly what this system exists to refuse.
    # An answer that claims to address the question but cites nothing we showed
    # it is discarded; only an honest "not addressed" survives without citation.
    if answer and not cited:
        answer = ""
        verdict = DirectAnswerVerdict.NOT_ADDRESSED
    if not answer and verdict is not DirectAnswerVerdict.NOT_ADDRESSED:
        verdict = DirectAnswerVerdict.NOT_ADDRESSED

    understood = (result.data.get("question_understood") or "").strip()[:180]
    return DirectAnswer(
        question_understood=understood,
        verdict=verdict,
        text=answer[:600],
        source_ids=cited,
    )


def _pending_clarifier(service: Service, answers: dict[str, str]) -> dict | None:
    for clar in service.clarifiers or []:
        if clar["id"] not in answers:
            return clar
    return None


def _institution_named_in(db: Session, text: str) -> Institution | None:
    """Find an institution the person named outright, by acronym or by name.

    This is Tier 2 doing its actual job. The directory exists so that a question
    we cannot answer still reaches the right desk, and someone who types "GPHA"
    has removed all doubt about which desk that is.

    Matching is deliberately strict. An abbreviation must appear as a whole word
    - otherwise "gra" matches "programme" - and a full name must appear in the
    question, not merely overlap with it.
    """
    words = set(content_tokens(text))
    if not words:
        return None

    best: Institution | None = None
    for inst in db.query(Institution).all():
        abbreviation = (inst.abbreviation or "").strip().lower()
        if abbreviation and len(abbreviation) >= 3 and abbreviation in words:
            return inst
        name = normalise(inst.name)
        if len(name) > 12 and name in normalise(text):
            # Prefer the longest full-name match, so "Ghana Revenue Authority"
            # wins over a shorter institution whose name is a substring.
            if best is None or len(inst.name) > len(best.name):
                best = inst
    return best


def _candidates(db: Session, matches: list[ServiceMatch]) -> list[CandidateService]:
    services = _by_id(db, Service, [m.service_id for m in matches])
    institutions = _by_id(
        db, Institution, [s.institution_id for s in services.values()]
    )

    out: list[CandidateService] = []
    for match in matches:
        service = services.get(match.service_id)
        if service is None:
            continue
        inst = institutions.get(service.institution_id)
        out.append(
            CandidateService(
                id=service.id,
                name=service.name,
                institution=(inst.abbreviation or inst.name) if inst else "",
                score=match.score,
                summary=service.summary,
            )
        )
    return out


def _refuse(
    db: Session,
    session_id: str,
    cleaned: str,
    normalised: str,
    matches: list[ServiceMatch],
    provider,
    trace: Trace,
    started: float,
) -> QueryResponse:
    """Tier 3. Say what we cannot confirm, name who probably can, log the gap.

    The refusal is not a dead end: the Tier 2 directory still routes the
    person to an institution, and the request joins the coverage backlog that
    decides what gets verified next.
    """
    trace.add("refusal", "Nothing cleared the relevance floor, so we decline rather than guess.")

    near_misses = [m for m in matches[:3] if m.score >= SUGGESTION_FLOOR]
    if matches and not near_misses:
        trace.add(
            "refusal",
            "Nothing was even close, so we are not offering alternatives that would "
            "only waste your time.",
        )

    # Route to an institution only when something was actually close. Naming
    # the DVLA to someone asking about importing a helicopter is not Tier 2
    # routing, it is a second guess wearing the clothes of a refusal.
    suggested: InstitutionOut | None = None

    # An institution the person named outright beats anything retrieval inferred.
    # Someone who types "GPHA" has told us exactly which body they mean, and
    # answering with a different agency's name - however related its services -
    # is the one mistake a directory must never make.
    named = _institution_named_in(db, cleaned)
    if named is not None:
        suggested = _institution_out(named)
        trace.add("directory", f"You named an institution directly: {named.name}.")
    elif near_misses:
        service = db.get(Service, near_misses[0].service_id)
        if service:
            suggested = _institution_out(db.get(Institution, service.institution_id))

    db.add(
        CoverageRequest(
            query_text=cleaned,
            suggested_institution_id=suggested.id if suggested else None,
        )
    )

    message = REFUSAL_TEMPLATE
    if suggested:
        message += (
            f" Based on what this involves, the responsible institution is most likely "
            f"{suggested.name}. Their official page and contact details are below."
        )
    else:
        message += (
            " We do not yet cover this service. We have logged your question — the "
            "services people ask for most are the ones we verify next."
        )

    query_id = _log(
        db, session_id, cleaned, normalised, "refused", None, 3, "low",
        matches[0].score if matches else 0.0, [], provider, {}, started,
    )
    db.commit()
    return QueryResponse(
        query_id=query_id,
        session_id=session_id,
        outcome=Outcome.REFUSED,
        message=message,
        suggested_institution=suggested,
        candidates=_candidates(db, near_misses),
        latency_ms=_elapsed(started),
        stages=trace.stages,
    )


def _log(
    db: Session,
    session_id: str,
    raw: str,
    normalised: str,
    outcome: str,
    service_id: str | None,
    tier: int | None,
    confidence: str | None,
    score: float | None,
    chunk_ids: list[str],
    provider,
    validator_report: dict,
    started: float,
) -> str:
    entry = QueryLog(
        session_id=session_id,
        raw_text=raw,
        normalised_text=normalised,
        outcome=outcome,
        resolved_service_id=service_id,
        coverage_tier=tier,
        confidence=confidence,
        top_score=score,
        retrieved_chunk_ids=chunk_ids,
        llm_provider=provider.name,
        llm_model=provider.model,
        prompt_version=PROMPT_VERSION,
        validator_report=validator_report,
        latency_ms=_elapsed(started),
    )
    db.add(entry)
    db.commit()
    return entry.id
