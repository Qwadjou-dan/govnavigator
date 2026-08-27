"""Authentication and saved checklists.

Sign-in is a one-time code sent to an email address or phone number. There is
no password for citizens, so there is no password to leak, and we store only
a keyed hash of the contact. In development the code is returned in the API
response so the flow can be demonstrated without an SMS or email provider —
that behaviour is disabled outside development.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import OneTimeCode, SavedChecklist, User
from ..schemas import (
    ChecklistOut,
    RequestCodeRequest,
    SaveChecklistRequest,
    TokenResponse,
    VerifyCodeRequest,
)
from ..security import (
    create_token,
    generate_code,
    hash_contact,
    hash_password,
    require_user,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
checklists = APIRouter(prefix="/checklists", tags=["checklists"])

CODE_TTL_MINUTES = 10


@router.post("/request-code")
def request_code(payload: RequestCodeRequest, db: Session = Depends(get_db)) -> dict:
    contact_hash = hash_contact(payload.contact)
    code = generate_code()
    db.add(
        OneTimeCode(
            contact_hash=contact_hash,
            code_hash=hash_password(code),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=CODE_TTL_MINUTES),
        )
    )
    db.commit()

    response = {
        "sent": True,
        "expires_in_minutes": CODE_TTL_MINUTES,
        "message": "We sent you a 6-digit code. It is valid for 10 minutes.",
    }
    if settings.app_env == "development":
        # Development convenience only. See docs/DEPLOYMENT.md before going live.
        response["dev_code"] = code
        response["message"] += " (development mode: the code is shown below)"
    return response


@router.post("/verify-code", response_model=TokenResponse)
def verify_code(payload: VerifyCodeRequest, db: Session = Depends(get_db)) -> TokenResponse:
    contact_hash = hash_contact(payload.contact)
    now = datetime.now(timezone.utc)

    candidates = (
        db.query(OneTimeCode)
        .filter(OneTimeCode.contact_hash == contact_hash, OneTimeCode.consumed.is_(False))
        .order_by(OneTimeCode.expires_at.desc())
        .limit(5)
        .all()
    )
    match = None
    for candidate in candidates:
        expires = candidate.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires < now:
            continue
        if verify_password(payload.code, candidate.code_hash):
            match = candidate
            break

    if match is None:
        raise HTTPException(401, "That code is not valid, or it has expired.")

    match.consumed = True

    user = db.query(User).filter(User.contact_hash == contact_hash).first()
    if user is None:
        user = User(contact_hash=contact_hash, display_label="You", role="citizen")
        db.add(user)
    db.commit()
    db.refresh(user)

    return TokenResponse(
        access_token=create_token(user.id, user.role),
        role=user.role,
        label=user.display_label or "You",
    )


@router.post("/curator-login", response_model=TokenResponse)
def curator_login(payload: VerifyCodeRequest, db: Session = Depends(get_db)) -> TokenResponse:
    """Curators use a password, because they change published content."""
    user = db.query(User).filter(User.contact_hash == hash_contact(payload.contact)).first()
    if user is None or user.role != "curator" or not user.password_hash:
        raise HTTPException(401, "Those details are not correct.")
    if not verify_password(payload.code, user.password_hash):
        raise HTTPException(401, "Those details are not correct.")
    return TokenResponse(
        access_token=create_token(user.id, user.role), role=user.role, label="Curator"
    )


@router.get("/me")
def me(user: User = Depends(require_user)) -> dict:
    return {"id": user.id, "role": user.role, "label": user.display_label}


# --------------------------------------------------------------------------
# saved checklists
# --------------------------------------------------------------------------


def _out(row: SavedChecklist) -> ChecklistOut:
    return ChecklistOut(
        id=row.id,
        service_id=row.service_id,
        title=row.title,
        payload=row.payload or {},
        progress=row.progress or {},
        updated_at=row.updated_at.isoformat(),
    )


@checklists.get("", response_model=list[ChecklistOut])
def list_checklists(user: User = Depends(require_user), db: Session = Depends(get_db)):
    rows = (
        db.query(SavedChecklist)
        .filter(SavedChecklist.user_id == user.id)
        .order_by(SavedChecklist.updated_at.desc())
        .all()
    )
    return [_out(r) for r in rows]


@checklists.post("", response_model=ChecklistOut)
def save_checklist(
    payload: SaveChecklistRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    row = (
        db.query(SavedChecklist)
        .filter(
            SavedChecklist.user_id == user.id,
            SavedChecklist.service_id == payload.service_id,
        )
        .first()
    )
    if row is None:
        row = SavedChecklist(user_id=user.id, service_id=payload.service_id)
        db.add(row)
    row.title = payload.title
    row.payload = payload.payload
    row.progress = payload.progress
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return _out(row)


@checklists.delete("/{checklist_id}")
def delete_checklist(
    checklist_id: str, user: User = Depends(require_user), db: Session = Depends(get_db)
) -> dict:
    row = db.get(SavedChecklist, checklist_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Not found.")
    db.delete(row)
    db.commit()
    return {"deleted": True}
