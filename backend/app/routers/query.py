"""The ask endpoint — the product's core loop."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..ai.pipeline import run_query
from ..db import get_db
from ..schemas import QueryRequest, QueryResponse
from ..security import rate_limit

router = APIRouter(prefix="/query", tags=["query"])


@router.post("", response_model=QueryResponse, dependencies=[Depends(rate_limit)])
def ask(payload: QueryRequest, db: Session = Depends(get_db)) -> QueryResponse:
    """Turn a plain-language goal into a validated, cited Answer Contract.

    Four outcomes are possible and all four are normal:
      answered — a grounded contract
      clarify  — one question, because guessing would be irresponsible
      refused  — nothing citable; we route to an institution instead
      blocked  — out of scope (legal/tax advice or circumvention)
    """
    return run_query(
        db,
        text=payload.text,
        session_id=payload.session_id,
        answers=payload.answers,
        forced_service_id=payload.service_id,
        skip_clarification=payload.skip_clarification,
        reopen=payload.reopen,
    )
