"""Assembles a validated Answer Contract from verified service content.

This is where the "grounded" in grounded-or-silent actually lives. Every
field is copied out of curated, source-tagged content in the database. The
language model is not involved in producing any of it; at most it writes the
one-line orientation sentence at the top, which is itself forbidden from
containing facts (see prompts.SUMMARY_SYSTEM).
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from sqlalchemy.orm import Session

from ..models import Institution, Service, Source
from ..schemas import (
    AnswerContract,
    Caveat,
    Confidence,
    DocumentItem,
    EligibilityItem,
    FeeItem,
    FieldStatus,
    InstitutionOut,
    Outcome,
    RejectionCause,
    RelatedService,
    SourceRef,
    StepItem,
    TimelineOut,
)
from .guardrails import apply_freshness, validate_contract


def _by_id(db: Session, model, ids: Iterable[str]) -> dict[str, object]:
    """Fetch many rows by primary key in one round trip.

    Assembling one answer resolves an institution, its dependents, every cited
    source and every related service. Fetched one at a time that is twenty-odd
    queries; on a local database nobody notices, but against a hosted Postgres
    each one is a network round trip and the wait becomes the whole experience.
    Order is preserved by the caller, which reads back out of this mapping.
    """
    wanted = [i for i in dict.fromkeys(ids) if i]
    if not wanted:
        return {}
    return {row.id: row for row in db.query(model).filter(model.id.in_(wanted)).all()}


def _institution_out(inst: Institution | None) -> InstitutionOut | None:
    if inst is None:
        return None
    return InstitutionOut(
        id=inst.id,
        name=inst.name,
        abbreviation=inst.abbreviation or "",
        mandate=inst.mandate or "",
        official_url=inst.official_url or "",
        portal_url=inst.portal_url or "",
        phone=inst.phone or "",
        email=inst.email or "",
        head_office=inst.head_office or "",
        digital_address=inst.digital_address or "",
        opening_hours=inst.opening_hours or "",
        offices=list(inst.offices or []),
        coverage_tier=inst.coverage_tier,
    )


def _parse_date(value) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def _status(raw) -> FieldStatus:
    try:
        return FieldStatus(raw)
    except (ValueError, TypeError):
        return FieldStatus.CONFIRMED


def build_contract(
    db: Session,
    service: Service,
    *,
    summary_override: str | None = None,
    generated_by: str = "grounded-assembler",
    prompt_version: str = "",
    eligibility_filter: dict[str, str] | None = None,
) -> AnswerContract:
    dep_ids = list(service.dependent_institution_ids or [])
    institutions = _by_id(db, Institution, [service.institution_id, *dep_ids])
    institution = institutions.get(service.institution_id)
    dependents = [
        out
        for dep_id in dep_ids
        if (out := _institution_out(institutions.get(dep_id))) is not None
    ]

    by_source_id = _by_id(db, Source, service.source_ids or [])
    sources = []
    for source_id in service.source_ids or []:
        src = by_source_id.get(source_id)
        if src is None:
            continue
        sources.append(
            SourceRef(
                id=src.id,
                title=src.title,
                publisher=src.publisher,
                url=src.url,
                is_official=src.is_official,
                retrieved_at=src.retrieved_at,
                effective_date=src.effective_date,
                note=src.note or "",
            )
        )

    filters = eligibility_filter or {}

    def applies(entry: dict) -> bool:
        """Honour clarification answers, e.g. sole trader vs limited company."""
        needs = entry.get("only_if")
        if not needs:
            return True
        for key, wanted in needs.items():
            given = filters.get(key)
            if given is not None and given != wanted:
                return False
        return True

    # Numbered after filtering, not before. A service whose steps branch (here
    # in Ghana, or at a mission abroad) stores both routes in one list, and a
    # route that opened at "6." would read as though five steps had gone
    # missing.
    step_items = [
        StepItem(
            order=position,
            action=item["action"],
            channel=item.get("channel", "either"),
            location=item.get("location", ""),
            note=item.get("note", ""),
            status=_status(item.get("status")),
            source_ref=item.get("source_ref"),
        )
        for position, item in enumerate(
            (item for item in (service.steps or []) if applies(item)), start=1
        )
    ]

    contract = AnswerContract(
        outcome=Outcome.ANSWERED,
        intent=service.category,
        service_id=service.id,
        service_name=service.name,
        summary=summary_override or service.summary,
        coverage_tier=service.coverage_tier,
        institution=_institution_out(institution),
        dependent_institutions=dependents,
        eligibility=[
            EligibilityItem(
                text=item["text"],
                applies_to=item.get("applies_to", "everyone"),
                status=_status(item.get("status")),
                source_ref=item.get("source_ref"),
            )
            for item in (service.eligibility or [])
            if applies(item)
        ],
        documents=[
            DocumentItem(
                name=item["name"],
                mandatory=item.get("mandatory", True),
                where_to_obtain=item.get("where_to_obtain", ""),
                note=item.get("note", ""),
                one_of_group=item.get("one_of_group"),
                status=_status(item.get("status")),
                source_ref=item.get("source_ref"),
            )
            for item in (service.documents or [])
            if applies(item)
        ],
        steps=step_items,
        fees=[
            FeeItem(
                label=item["label"],
                amount_ghs=item.get("amount_ghs"),
                amount_text=item.get("amount_text"),
                effective_date=_parse_date(item.get("effective_date")),
                status=_status(item.get("status")),
                note=item.get("note", ""),
                source_ref=item.get("source_ref"),
            )
            for item in (service.fees or [])
            if applies(item)
        ],
        timeline=(
            TimelineOut(
                standard=(service.timeline or {}).get("standard"),
                expedited=(service.timeline or {}).get("expedited"),
                status=_status((service.timeline or {}).get("status")),
                note=(service.timeline or {}).get("note", ""),
                source_ref=(service.timeline or {}).get("source_ref"),
            )
            if service.timeline
            else None
        ),
        common_rejection_causes=[
            RejectionCause(
                text=item["text"],
                evidence_level=item.get("evidence_level", "inferred"),
                source_ref=item.get("source_ref"),
            )
            for item in (service.rejection_causes or [])
        ],
        related_services=_related(db, service),
        sources=sources,
        caveats=[Caveat(kind=c.get("kind", "scope"), text=c["text"]) for c in (service.caveats or [])],
        last_reviewed_by_team=service.reviewed_at.date() if service.reviewed_at else None,
        content_version=service.content_version,
        generated_by=generated_by,
        prompt_version=prompt_version,
    )

    contract.steps.sort(key=lambda s: s.order)

    # The team has not yet verified this card against the agency. Say so.
    if service.reviewed_at is None:
        contract.caveats.insert(
            0,
            Caveat(
                kind="coverage",
                text=(
                    "This service card was built from official sources but has not yet been "
                    "confirmed with the institution by our team. Check the official source "
                    "links before you travel or pay."
                ),
            ),
        )

    contract = validate_contract(contract)
    contract = apply_freshness(contract)
    contract.confidence = _confidence(contract)
    return contract


def _related(db: Session, service: Service) -> list[RelatedService]:
    related_ids = list(service.related_service_ids or [])
    by_service_id = _by_id(db, Service, related_ids)
    by_institution_id = _by_id(
        db, Institution, [r.institution_id for r in by_service_id.values()]
    )

    out: list[RelatedService] = []
    for rid in related_ids:
        rel = by_service_id.get(rid)
        if rel is None:
            continue
        inst = by_institution_id.get(rel.institution_id)
        out.append(
            RelatedService(
                id=rel.id,
                name=rel.name,
                institution=(inst.abbreviation or inst.name) if inst else "",
                reason="Commonly needed for the same goal",
            )
        )
    return out


def _confidence(contract: AnswerContract) -> Confidence:
    """Derived from evidence, never asserted by a model.

    A contract is only high-confidence when it is a verified Tier 1 card,
    nothing was dropped by the validator, the content is fresh, the two fields
    people act on — documents and steps — are actually populated, and most of
    those come from the institution's own published word.

    That last condition was added after a DVLA card came out reading "high"
    while every fee on it was unpublished and half its steps were our reading of
    how the pieces fit. The confidence meter is a promise to the person about
    how much of this the State actually said. A card assembled mostly from
    inference can be the best available answer and still not be a confident one.
    """
    report = contract.validator
    has_core = bool(contract.documents) and bool(contract.steps)

    actionable = [*contract.documents, *contract.steps]
    confirmed = sum(1 for item in actionable if item.status is FieldStatus.CONFIRMED)
    mostly_official = bool(actionable) and confirmed / len(actionable) >= 0.6

    if (
        contract.coverage_tier == 1
        and report.fields_dropped == 0
        and report.strict_fields_ok
        and contract.freshness.value == "fresh"
        and has_core
        and mostly_official
    ):
        return Confidence.HIGH
    if contract.coverage_tier == 1 and has_core and report.strict_fields_ok:
        return Confidence.MEDIUM
    return Confidence.LOW
