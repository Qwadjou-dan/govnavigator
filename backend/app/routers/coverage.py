"""Human escalation capture — the "none of this applies, I need a person" path.

FR-13 asks for a named human route when the system cannot help. The click that
sends a person there is also signal for the curator: someone asking to escalate
from a card we thought was answered is reporting something that card does not
cover. Logging it as a coverage request puts it in the same ranked backlog as a
refusal, so what gets verified next is decided by real people rather than by
our assumptions.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import CoverageRequest
from ..schemas import EscalationRequest
from ..security import rate_limit

router = APIRouter(prefix="/coverage", tags=["coverage"])


@router.post("/escalate", dependencies=[Depends(rate_limit)])
def escalate(payload: EscalationRequest, db: Session = Depends(get_db)) -> dict:
    db.add(
        CoverageRequest(
            query_text=payload.query_text.strip()[:1000],
            suggested_institution_id=payload.institution_id,
        )
    )
    db.commit()
    return {
        "recorded": True,
        "message": (
            "We have flagged this for a member of the team. If you need to "
            "speak to the institution directly, their contact details are below."
        ),
    }