"""Curator console API.

Three jobs: see how the system is actually performing, mark service cards as
verified against the institution, and work the correction queue. The coverage
backlog is ranked by what real users asked for and did not get, not by what
the team assumed would be popular.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..config import settings
from ..ai.retrieval import retriever
from ..db import get_db
from ..models import (
    AnswerLog,
    CoverageRequest,
    Feedback,
    Institution,
    QueryLog,
    Service,
    Source,
    User,
)
from ..security import require_curator

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/overview")
def overview(
    days: int = 30, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    logs = db.query(QueryLog).filter(QueryLog.created_at >= since).all()

    outcomes = Counter(log.outcome for log in logs)
    total = len(logs) or 1
    latencies = sorted(log.latency_ms for log in logs) or [0]

    def pct(idx: float) -> int:
        return latencies[min(len(latencies) - 1, int(len(latencies) * idx))]

    unsourced = sum(
        (log.validator_report or {}).get("unsourced_claims", 0) for log in logs
    )
    dropped = sum((log.validator_report or {}).get("fields_dropped", 0) for log in logs)

    feedback = db.query(Feedback).filter(Feedback.created_at >= since).all()
    verdicts = Counter(f.verdict for f in feedback)

    services = db.query(Service).all()
    return {
        "window_days": days,
        "queries": {
            "total": len(logs),
            "answered": outcomes.get("answered", 0),
            "clarify": outcomes.get("clarify", 0),
            "refused": outcomes.get("refused", 0),
            "blocked": outcomes.get("blocked", 0),
            "answer_rate": round(outcomes.get("answered", 0) / total, 3),
            "refusal_rate": round(outcomes.get("refused", 0) / total, 3),
        },
        "quality": {
            "unsourced_claims_blocked": unsourced,
            "fields_dropped_by_validator": dropped,
            "p50_latency_ms": pct(0.5),
            "p95_latency_ms": pct(0.95),
            "token_cost": sum(log.token_cost for log in logs),
        },
        "feedback": {
            "total": len(feedback),
            "matched_at_office": verdicts.get("yes", 0),
            "partly": verdicts.get("partly", 0),
            "did_not_match": verdicts.get("no", 0),
            "open_corrections": db.query(Feedback).filter(Feedback.status == "open").count(),
        },
        "content": {
            "services": len(services),
            "verified_by_team": sum(1 for s in services if s.reviewed_at is not None),
            "sources": db.query(Source).count(),
            "official_sources": db.query(Source).filter(Source.is_official.is_(True)).count(),
        },
    }


@router.get("/coverage-gaps")
def coverage_gaps(
    limit: int = 25, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> list[dict]:
    """The Tier 3 backlog: what people asked for and did not get.

    This is the demand signal that decides what gets verified next.
    """
    rows = (
        db.query(
            CoverageRequest.query_text,
            func.count(CoverageRequest.id).label("times"),
            func.max(CoverageRequest.suggested_institution_id).label("institution"),
        )
        .filter(CoverageRequest.status == "open")
        .group_by(CoverageRequest.query_text)
        .order_by(func.count(CoverageRequest.id).desc())
        .limit(limit)
        .all()
    )
    return [
        {"query": r.query_text, "times_asked": r.times, "likely_institution": r.institution}
        for r in rows
    ]


@router.get("/corrections")
def corrections(
    status: str = "open", db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> list[dict]:
    rows = (
        db.query(Feedback)
        .filter(Feedback.status == status)
        .order_by(Feedback.created_at.desc())
        .limit(100)
        .all()
    )
    out = []
    for row in rows:
        service = db.get(Service, row.service_id) if row.service_id else None
        out.append(
            {
                "id": row.id,
                "service_id": row.service_id,
                "service_name": service.name if service else None,
                "verdict": row.verdict,
                "comment": row.comment,
                "created_at": row.created_at.isoformat(),
                "answer_id": row.answer_id,
            }
        )
    return out


@router.post("/corrections/{feedback_id}/resolve")
def resolve_correction(
    feedback_id: str,
    resolution: str = "",
    db: Session = Depends(get_db),
    curator: User = Depends(require_curator),
) -> dict:
    row = db.get(Feedback, feedback_id)
    if row is None:
        raise HTTPException(404, "Not found.")
    row.status = "resolved"
    row.curator_id = curator.id
    row.resolution = resolution[:2000]
    db.commit()
    return {"resolved": True}


@router.post("/services/{service_id}/verify")
def verify_service(
    service_id: str, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> dict:
    """Mark a card as checked against the institution.

    Until a human does this, every answer for that service carries a caveat
    saying so. Verification is the only thing that removes it, and it records
    who did it and when.
    """
    service = db.get(Service, service_id)
    if service is None:
        raise HTTPException(404, "Not found.")
    service.reviewed_by = curator.id
    service.reviewed_at = datetime.now(timezone.utc)
    service.content_version += 1
    db.commit()
    retriever.refresh(db)
    return {
        "verified": True,
        "service_id": service_id,
        "reviewed_at": service.reviewed_at.isoformat(),
        "content_version": service.content_version,
    }


@router.get("/answers/{answer_id}")
def audit_answer(
    answer_id: str, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> dict:
    """Reconstruct exactly what a user was shown, for any answer we served."""
    answer = db.get(AnswerLog, answer_id)
    if answer is None:
        raise HTTPException(404, "Not found.")
    query = db.get(QueryLog, answer.query_id)
    return {
        "answer": {
            "id": answer.id,
            "service_id": answer.service_id,
            "content_version": answer.content_version,
            "created_at": answer.created_at.isoformat(),
            "contract": answer.contract,
        },
        "query": {
            "text": query.raw_text if query else "",
            "outcome": query.outcome if query else "",
            "llm_provider": query.llm_provider if query else "",
            "llm_model": query.llm_model if query else "",
            "prompt_version": query.prompt_version if query else "",
            "validator_report": query.validator_report if query else {},
            "retrieved_chunk_ids": query.retrieved_chunk_ids if query else [],
        },
    }


@router.get("/analytics")
def analytics(
    days: int = 30, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> dict:
    """What the system has actually been asked, by day and by service.

    Log volume is modest and the query window is bounded, so the aggregation
    happens in Python rather than with a date_trunc — SQLite and Postgres would
    otherwise need different SQL for nothing. Days with zero activity appear as
    zeros so a widening gap in usage is visible rather than silently missing.
    """
    since = datetime.now(timezone.utc) - timedelta(days=days)
    logs = db.query(QueryLog).filter(QueryLog.created_at >= since).all()
    feedback = db.query(Feedback).filter(Feedback.created_at >= since).all()

    # Zero-filled day series so quiet days are visible, not absent.
    day_keys = [(since + timedelta(days=i)).date().isoformat() for i in range(days + 1)]
    daily: dict[str, dict[str, int]] = {
        d: {"queries": 0, "answered": 0, "refused": 0, "clarify": 0, "blocked": 0}
        for d in day_keys
    }
    outcomes: Counter = Counter()
    languages: Counter = Counter()
    service_queries: Counter = Counter()

    for log in logs:
        day = log.created_at.date().isoformat()
        if day in daily:
            daily[day]["queries"] += 1
            daily[day][log.outcome] = daily[day].get(log.outcome, 0) + 1
        outcomes[log.outcome] += 1
        languages[log.detected_language or "en"] += 1
        if log.resolved_service_id:
            service_queries[log.resolved_service_id] += 1

    # Map service ids to names once.
    names = {s.id: s.name for s in db.query(Service).all()}
    top_services = [
        {"service_id": sid, "name": names.get(sid, sid), "queried": count}
        for sid, count in service_queries.most_common(5)
    ]

    verdicts: Counter = Counter(f.verdict for f in feedback)

    return {
        "window_days": days,
        "daily": [{"date": d, **daily[d]} for d in day_keys],
        "outcome_split": {
            "answered": outcomes.get("answered", 0),
            "clarify": outcomes.get("clarify", 0),
            "refused": outcomes.get("refused", 0),
            "blocked": outcomes.get("blocked", 0),
            "total": len(logs),
        },
        "top_services": top_services,
        "languages": [
            {"language": lang, "count": count}
            for lang, count in languages.most_common()
        ],
        "feedback_verdicts": {
            "yes": verdicts.get("yes", 0),
            "partly": verdicts.get("partly", 0),
            "no": verdicts.get("no", 0),
        },
    }


@router.get("/verification-audit")
def verification_audit(
    db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> dict:
    """One row per service card, scored for what needs a human's attention.

    This is the working list for the team audit: nothing can be "verified
    against the institution" except by a person who actually checks, so the
    console ranks the 27 cards by the signals that say "do me next" — never
    confirmed, a source going old, or no official citation to stand on. The
    freshness rule mirrors the one users see (guardrails.apply_freshness): a
    card is old when its OLDEST source is old.
    """
    services = db.query(Service).all()
    sources = {s.id: s for s in db.query(Source).all()}
    institutions = {i.id: i for i in db.query(Institution).all()}

    warn_before = datetime.now(timezone.utc).date() - timedelta(days=settings.freshness_warn_days)
    stale_before = datetime.now(timezone.utc).date() - timedelta(days=settings.freshness_stale_days)

    rows = []
    for service in services:
        service_sources = [sources[sid] for sid in (service.source_ids or []) if sid in sources]
        official = sum(1 for s in service_sources if s.is_official)
        dates = [s.retrieved_at for s in service_sources if s.retrieved_at]
        if not dates:
            freshness = "none"
        else:
            oldest = min(dates)
            if oldest < stale_before:
                freshness = "stale"
            elif oldest < warn_before:
                freshness = "verify"
            else:
                freshness = "fresh"

        reviewed = service.reviewed_at is not None
        needs_action = (not reviewed) or (freshness in ("verify", "stale")) or (official == 0)

        inst = institutions.get(service.institution_id)
        rows.append(
            {
                "id": service.id,
                "name": service.name,
                "institution": inst.name if inst else service.institution_id,
                "institution_abbr": (inst.abbreviation if inst else "") or "—",
                "category": service.category,
                "coverage_tier": service.coverage_tier,
                "reviewed": reviewed,
                "reviewed_by": service.reviewed_by,
                "reviewed_at": service.reviewed_at.isoformat() if service.reviewed_at else None,
                "source_count": len(service_sources),
                "official_source_count": official,
                "freshness": freshness,
                "needs_action": needs_action,
            }
        )

    rows.sort(key=lambda r: (not r["needs_action"], r["name"].lower()))
    summary = {
        "total": len(rows),
        "verified": sum(1 for r in rows if r["reviewed"]),
        "unverified": sum(1 for r in rows if not r["reviewed"]),
        "needs_action": sum(1 for r in rows if r["needs_action"]),
    }
    return {"summary": summary, "rows": rows}


@router.get("/recent-queries")
def recent_queries(
    limit: int = 50, db: Session = Depends(get_db), curator: User = Depends(require_curator)
) -> list[dict]:
    rows = db.query(QueryLog).order_by(QueryLog.created_at.desc()).limit(limit).all()
    return [
        {
            "id": r.id,
            "text": r.raw_text,
            "outcome": r.outcome,
            "service_id": r.resolved_service_id,
            "confidence": r.confidence,
            "score": r.top_score,
            "latency_ms": r.latency_ms,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]
