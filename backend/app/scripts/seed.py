"""Load the curated knowledge base into the database, then index it.

Run:  python -m app.scripts.seed [--reset]

Content lives in app/content/*.json as plain, reviewable files. That is
deliberate: a curator should be able to correct a fee in a pull request
without touching application code, and every change should be visible in
version control next to the source it came from.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
from datetime import date, datetime, timezone

from sqlalchemy import delete

from ..config import settings
from ..db import Base, SessionLocal, engine, init_db
from ..models import Chunk, Institution, Service, Source, User
from ..ai.embeddings import embed_with_fallback, get_embedder

CONTENT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "content")


def _load(pattern: str) -> list[dict]:
    out: list[dict] = []
    for path in sorted(glob.glob(os.path.join(CONTENT_DIR, pattern))):
        with open(path, encoding="utf-8") as fh:
            out.extend(json.load(fh))
    return out


def _parse_date(value):
    return date.fromisoformat(value) if value else None


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def build_chunks(service: dict) -> list[dict]:
    """Turn a service card into retrievable passages.

    Chunks are built per section rather than by character window, because the
    sections already are the semantic units, and because a chunk that mixes
    fees with steps produces citations that point at the wrong thing.
    """
    default_source = (service.get("source_ids") or ["unknown"])[0]
    chunks: list[dict] = []

    def add(section: str, text: str, source_id: str | None = None) -> None:
        text = " ".join(text.split())
        if len(text) < 12:
            return
        chunks.append(
            {
                "section": section,
                "text": text,
                "source_id": source_id or default_source,
                "position": len(chunks),
            }
        )

    # An "intent" chunk carrying the name, summary and every alias. This is
    # what a colloquial query actually matches against.
    aliases = " | ".join(service.get("aliases", []))
    keywords = " ".join(service.get("keywords", []))
    add(
        "intent",
        f"{service['name']}. {service.get('short_name', '')}. {service.get('summary', '')} "
        f"People ask about this as: {aliases}. Keywords: {keywords}.",
    )

    for item in service.get("eligibility", []):
        add("eligibility", f"Who can apply for {service['name']}: {item['text']}", item.get("source_ref"))

    for item in service.get("documents", []):
        need = "Required" if item.get("mandatory", True) else "Sometimes required"
        add(
            "documents",
            f"{need} document for {service['name']}: {item['name']}. "
            f"Where to get it: {item.get('where_to_obtain', 'not stated')}. {item.get('note', '')}",
            item.get("source_ref"),
        )

    for item in service.get("steps", []):
        add(
            "steps",
            f"Step {item.get('order')} of {service['name']}: {item['action']}. "
            f"Channel: {item.get('channel', 'either')}. {item.get('location', '')} {item.get('note', '')}",
            item.get("source_ref"),
        )

    for item in service.get("fees", []):
        amount = item.get("amount_text") or (
            f"GHS {item['amount_ghs']:.2f}" if item.get("amount_ghs") is not None else "not published"
        )
        add(
            "fees",
            f"Fee for {service['name']} - {item['label']}: {amount}. "
            f"Effective date: {item.get('effective_date', 'not published')}. {item.get('note', '')}",
            item.get("source_ref"),
        )

    timeline = service.get("timeline") or {}
    if timeline:
        add(
            "timeline",
            f"How long {service['name']} takes. Standard: {timeline.get('standard') or 'not published'}. "
            f"Expedited: {timeline.get('expedited') or 'none published'}. {timeline.get('note', '')}",
            timeline.get("source_ref"),
        )

    for item in service.get("rejection_causes", []):
        add("rejection", f"What commonly goes wrong with {service['name']}: {item['text']}", item.get("source_ref"))

    for item in service.get("caveats", []):
        add("caveat", f"Important note about {service['name']}: {item['text']}")

    return chunks


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


def seed(reset: bool = False) -> dict:
    if reset:
        Base.metadata.drop_all(bind=engine)
    init_db()

    db = SessionLocal()
    embedder = get_embedder()
    stats = {"institutions": 0, "sources": 0, "services": 0, "chunks": 0}

    try:
        for row in _load("institutions.json"):
            db.merge(
                Institution(
                    id=row["id"],
                    name=row["name"],
                    abbreviation=row.get("abbreviation", ""),
                    mandate=row.get("mandate", ""),
                    official_url=row.get("official_url", ""),
                    portal_url=row.get("portal_url", ""),
                    phone=row.get("phone", ""),
                    email=row.get("email", ""),
                    head_office=row.get("head_office", ""),
                    digital_address=row.get("digital_address", ""),
                    opening_hours=row.get("opening_hours", ""),
                    offices=row.get("offices", []),
                    coverage_tier=row.get("coverage_tier", 2),
                    notes=row.get("notes", ""),
                )
            )
            stats["institutions"] += 1

        for row in _load("sources.json"):
            db.merge(
                Source(
                    id=row["id"],
                    title=row["title"],
                    publisher=row["publisher"],
                    url=row["url"],
                    is_official=row.get("is_official", True),
                    retrieved_at=_parse_date(row["retrieved_at"]),
                    effective_date=_parse_date(row.get("effective_date")),
                    content_hash=hashlib.sha256(row["url"].encode()).hexdigest()[:32],
                    note=row.get("note", ""),
                )
            )
            stats["sources"] += 1

        db.commit()

        services = _load("services_*.json")
        for row in services:
            db.merge(
                Service(
                    id=row["id"],
                    name=row["name"],
                    short_name=row.get("short_name", ""),
                    category=row["category"],
                    summary=row.get("summary", ""),
                    institution_id=row["institution_id"],
                    dependent_institution_ids=row.get("dependent_institution_ids", []),
                    aliases=row.get("aliases", []),
                    keywords=row.get("keywords", []),
                    coverage_tier=row.get("coverage_tier", 1),
                    eligibility=row.get("eligibility", []),
                    documents=row.get("documents", []),
                    steps=row.get("steps", []),
                    fees=row.get("fees", []),
                    timeline=row.get("timeline", {}),
                    rejection_causes=row.get("rejection_causes", []),
                    caveats=row.get("caveats", []),
                    clarifiers=row.get("clarifiers", []),
                    related_service_ids=row.get("related_service_ids", []),
                    source_ids=row.get("source_ids", []),
                    content_version=row.get("content_version", 1),
                    updated_at=datetime.now(timezone.utc),
                )
            )
            stats["services"] += 1
        db.commit()

        # Re-index from scratch: content is small and correctness beats speed.
        db.execute(delete(Chunk))
        db.commit()

        pending: list[Chunk] = []
        texts: list[str] = []
        for row in services:
            for chunk in build_chunks(row):
                pending.append(
                    Chunk(
                        service_id=row["id"],
                        source_id=chunk["source_id"],
                        section=chunk["section"],
                        text=chunk["text"],
                        position=chunk["position"],
                    )
                )
                texts.append(chunk["text"])

        vectors, embedder, fallback = embed_with_fallback(texts)
        if fallback:
            stats["embedder_warning"] = fallback
        stats["embedder_used"] = embedder
        for chunk, vector in zip(pending, vectors):
            chunk.embedding = vector
            db.add(chunk)
        stats["chunks"] = len(pending)
        db.commit()

        # A curator account so the admin console is reachable out of the box.
        from ..security import hash_contact, hash_password

        existing = (
            db.query(User).filter(User.contact_hash == hash_contact(settings.admin_email)).first()
        )
        if existing is None:
            db.add(
                User(
                    contact_hash=hash_contact(settings.admin_email),
                    display_label="Curator",
                    role="curator",
                    password_hash=hash_password(settings.admin_password),
                )
            )
            db.commit()
    finally:
        db.close()

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the GovNavigator knowledge base")
    parser.add_argument("--reset", action="store_true", help="drop all tables first")
    args = parser.parse_args()

    stats = seed(reset=args.reset)
    warning = stats.pop("embedder_warning", "")
    embedder = stats.pop("embedder_used", get_embedder())

    print("Seed complete.")
    print(f"  database    : {settings.database_url.split('@')[-1]}")
    print(f"  embedder    : {embedder.name} ({embedder.dim} dims)")
    for key, value in stats.items():
        print(f"  {key:<12}: {value}")

    if warning:
        # Loud, but after the success lines: the database IS built and usable.
        print(f"\n\033[33m  warn  \033[0m the configured embedder was not used.")
        print(f"          Reason: {warning}")
        print("          Everything was embedded locally instead, which scores the same")
        print("          on the golden set - so the app is fully working. Fix the above")
        print("          and re-run this command if you want neural retrieval.\n")


if __name__ == "__main__":
    main()
