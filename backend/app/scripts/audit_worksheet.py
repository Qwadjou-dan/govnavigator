"""Team verification worksheet generator.

Run:  python -m app.scripts.audit_worksheet [--out docs/VERIFICATION_WORKSHEET.md]

Prints a Markdown checklist for the 27-service audit — one row per service
card with the facts a verifier should confirm against the institution, each
source's URL to check, the freshness verdict, and empty columns for the
person's name and date. The console audit (`/admin/verification-audit`) sorts
the same list; this is the printable companion the team works through.

It reads the seeded database, because verification status and dates live there
and the review tool we are feeding must reflect what the app actually serves.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

try:
    from ..config import settings
    from ..db import SessionLocal
    from ..models import Institution, Service, Source
except ModuleNotFoundError as exc:  # pragma: no cover - environment problem
    print(f"\n\033[31m fail \033[0m '{getattr(exc, 'name', 'a required package')}' is not installed.")
    print("           Activate the virtualenv and `pip install -r requirements.txt` first.\n")
    sys.exit(1)

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def _freshness(service_sources: list[Source], today) -> str:
    """Mirror guardrails.apply_freshness: a card is as old as its oldest source."""
    dates = [s.retrieved_at for s in service_sources if s.retrieved_at]
    if not dates:
        return "none"
    oldest = min(dates)
    warn = today - timedelta(days=settings.freshness_warn_days)
    stale = today - timedelta(days=settings.freshness_stale_days)
    if oldest < stale:
        return "stale"
    if oldest < warn:
        return "verify"
    return "fresh"


def build_rows(db) -> list[dict]:
    services = db.query(Service).all()
    all_sources = {s.id: s for s in db.query(Source).all()}
    institutions = {i.id: i.name for i in db.query(Institution).all()}
    today = datetime.now(timezone.utc).date()

    rows = []
    for service in sorted(services, key=lambda s: s.name.lower()):
        service_sources = [
            all_sources[sid] for sid in (service.source_ids or []) if sid in all_sources
        ]
        rows.append(
            {
                "name": service.name,
                "institution": institutions.get(service.institution_id, service.institution_id),
                "category": service.category,
                "fees": len(service.fees or []),
                "documents": len(service.documents or []),
                "steps": len(service.steps or []),
                "timeline": "yes" if (service.timeline or {}) else "no",
                "freshness": _freshness(service_sources, today),
                "reviewed": "done" if service.reviewed_at else "open",
                "sources": service_sources,
            }
        )
    return rows


def render(rows: list[dict]) -> str:
    out: list[str] = [
        "# GovNavigator Ghana — service verification worksheet",
        "",
        "*Every card must be confirmed against the institution's own publication before it is "
        "marked verified in the console. Marking verified is the only action that removes the "
        "“not yet been confirmed by our team” caveat from that card's answers.*",
        "",
        f"Generated {datetime.now(timezone.utc).date().isoformat()} · "
        f"{len(rows)} cards · freshness = oldest source date vs "
        f"{settings.freshness_warn_days} day warn / {settings.freshness_stale_days} day stale policy.",
        "",
        "| Service | Institution | Fees | Docs | Steps | Timeline | Freshness | Status | Checked by | Date |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        src = max(r["sources"], key=lambda s: s.retrieved_at or datetime.min.date()).url if r["sources"] else "no source"
        out.append(
            f"| {r['name']} ({r['category']}) | {r['institution']} | {r['fees']} | {r['documents']} | "
            f"{r['steps']} | {r['timeline']} | {r['freshness']} | {r['reviewed']} |  |  |"
        )
        for s in r["sources"]:
            out.append(f"| &nbsp; | source: {s.publisher} — {s.url} | | | | | | | | |")
    out.append("")
    return "\n".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the 27-service verification worksheet")
    parser.add_argument("--out", metavar="FILE", help="write the worksheet to this file (default: stdout)")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        rows = build_rows(db)
    finally:
        db.close()

    text = render(rows)
    if args.out:
        parent = os.path.dirname(args.out)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(f"{GREEN} ok {RESET} wrote {len(rows)} rows to {args.out}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())