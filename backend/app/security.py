"""Authentication, hashing and rate limiting.

Identity is deliberately thin. Asking a question needs no account at all.
An account exists only so a checklist can be saved and picked up again, and
we store a hash of the contact rather than the contact itself. Curators get
a password because they change published content and that must be auditable.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

bearer = HTTPBearer(auto_error=False)

# bcrypt silently truncates anything past 72 bytes, so a long passphrase would
# be weaker than it looks. Reject rather than truncate.
_MAX_PASSWORD_BYTES = 72


# --------------------------------------------------------------------------
# hashing
# --------------------------------------------------------------------------


def hash_contact(contact: str) -> str:
    """Keyed hash of an email or phone. We never store the contact itself."""
    return hmac.new(
        settings.jwt_secret.encode(), contact.strip().lower().encode(), hashlib.sha256
    ).hexdigest()


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")
    if len(raw) > _MAX_PASSWORD_BYTES:
        raise ValueError("Password is too long (bcrypt accepts up to 72 bytes).")
    return bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Constant-time comparison. Never raises on malformed input."""
    try:
        return bcrypt.checkpw(password.encode("utf-8")[:_MAX_PASSWORD_BYTES], hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


# --------------------------------------------------------------------------
# tokens
# --------------------------------------------------------------------------


def create_token(user_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "iat": int(time.time()),
        "exp": datetime.now(timezone.utc) + timedelta(hours=settings.session_ttl_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        return None


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User | None:
    """Optional identity. Most endpoints work perfectly well without one."""
    if creds is None:
        return None
    payload = decode_token(creds.credentials)
    if not payload:
        return None
    return db.get(User, payload.get("sub"))


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to use this.")
    return user


def require_curator(user: User | None = Depends(current_user)) -> User:
    if user is None or user.role != "curator":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Curator access required.")
    return user


# --------------------------------------------------------------------------
# rate limiting
# --------------------------------------------------------------------------


class SlidingWindowLimiter:
    """In-process limiter, adequate for a single-instance MVP.

    Documented limitation: with more than one API instance this must move to
    Redis or the gateway, because each process keeps its own counters.
    """

    def __init__(self, per_minute: int, burst: int) -> None:
        self.per_minute = per_minute
        self.burst = burst
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> bool:
        now = time.monotonic()
        window = self._hits[key]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self.per_minute:
            return False
        recent = sum(1 for t in window if now - t < 5)
        if recent >= self.burst:
            return False
        window.append(now)
        return True


limiter = SlidingWindowLimiter(settings.rate_limit_per_minute, settings.rate_limit_burst)


def rate_limit(request: Request) -> None:
    client = request.client.host if request.client else "unknown"
    if not limiter.check(client):
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "That is a lot of questions very quickly. Please wait a moment and try again.",
        )
