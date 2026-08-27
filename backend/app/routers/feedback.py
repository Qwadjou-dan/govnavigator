"""Feedback capture — how the corpus learns from contact with the counter.

The question we ask is deliberately not "was this helpful?". It is "was this
what you found at the office?", because that is the only feedback that can
correct a fee.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Feedback
from ..schemas import FeedbackRequest
from ..security import rate_limit

router = APIRouter(prefix="/feedback", tags=["feedback"])


@router.post("", dependencies=[Depends(rate_limit)])
def submit(payload: FeedbackRequest, db: Session = Depends(get_db)) -> dict:
    entry = Feedback(
        answer_id=payload.answer_id,
        service_id=payload.service_id,
        verdict=payload.verdict,
        comment=payload.comment.strip()[:2000],
    )
    db.add(entry)
    db.commit()

    if payload.verdict == "no":
        message = (
            "Thank you — that is the most useful kind of feedback we get. "
            "This entry goes to a curator for re-checking against the official source."
        )
    elif payload.verdict == "partly":
        message = "Thank you. We have logged what was different so a curator can look at it."
    else:
        message = "Thank you for confirming."

    return {"recorded": True, "id": entry.id, "message": message}
