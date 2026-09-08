"""Outbound notifications. Currently one job: emailing the one-time login code.

Resend is the default provider (free tier, no card). Sending is deliberate and
synchronous: a failure surfaces to the API caller, so the app can tell the
person honestly that the code did not go out instead of pretending it did.
"""
from __future__ import annotations

import logging

import httpx

from .config import settings

log = logging.getLogger("govnavigator.notify")

RESEND_URL = "https://api.resend.com/emails"


class NotifyError(RuntimeError):
    """Delivery could not be completed — the caller should tell the person."""


def send_login_code(contact: str, code: str) -> None:
    """Email a login code to `contact`. Raises NotifyError on failure."""
    if not settings.resend_api_key:
        raise NotifyError("No email provider configured (RESEND_API_KEY is empty).")

    if "@" not in contact:
        raise NotifyError("Only email OTP is wired in this deployment.")

    body = (
        "Your GovNavigator login code is:\n\n"
        f"    {code}\n\n"
        "It is valid for 10 minutes. If you did not request it, you can ignore "
        "this message."
    )

    try:
        resp = httpx.post(
            RESEND_URL,
            headers={
                "Authorization": f"Bearer {settings.resend_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": settings.email_from,
                "to": [contact],
                "subject": "Your GovNavigator login code",
                "text": body,
            },
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        raise NotifyError(f"Email provider unreachable: {exc}") from exc

    if resp.status_code >= 300:
        raise NotifyError(f"Email provider returned {resp.status_code}: {resp.text[:300]}")
