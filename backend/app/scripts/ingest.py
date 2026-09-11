"""Source change-detection (FR-10). Observational only — never edits the served knowledge base.

Run:  python -m app.scripts.ingest [--limit N] [--json out.json] [--reembed]

The corpus is curated by hand on purpose: a crawled page is untrusted input
(see guardrails.py — it could contain anything). So the pipeline's job is to
tell the team *when an official source has changed*, not to paste the change
into the answer the public reads. Every run fetches each registered source,
hashes the raw bytes (PDFs included, without parsing them), and records a
CrawlSnapshot. Comparing against the source's previous snapshot classifies the
fetch NEW / CHANGED / UNCHANGED / FAILED. A CHANGED flag means a curator edits
the content JSON and PRs it — the crawl itself touches nothing.

`--reembed` has nothing to do with crawling: it re-runs the embedder over the
already-curated chunks (e.g. after switching EMBEDDING_PROVIDER), which the
embeddings layer's docstring advertises through exactly this flag.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone

try:
    import httpx
except ModuleNotFoundError:  # pragma: no cover - environment problem
    print("\n\033[31m fail \033[0m 'httpx' is not installed.")
    print("           Activate the virtualenv and `pip install -r requirements.txt`.\n")
    sys.exit(1)

try:
    from ..ai.embeddings import embed_with_fallback
    from ..db import SessionLocal, init_db
    from ..models import Chunk, CrawlSnapshot, Source
except ModuleNotFoundError as exc:  # pragma: no cover - environment problem
    print(f"\n\033[31m fail \033[0m '{getattr(exc, 'name', 'a required package')}' failed to import.")
    sys.exit(1)

GREEN, RED, YELLOW, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m",
)
OK, WARN, FAIL = f"{GREEN}  ok  {RESET}", f"{YELLOW} warn {RESET}", f"{RED} fail {RESET}"

FETCH_TIMEOUT = 30.0


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch_source(url: str) -> tuple[int, bytes, str]:
    """Fetch a source and return (http_status, body_bytes, error).

    Returns (0, b"", error) when the request itself fails so callers see a
    FAILED snapshot rather than an exception. Bytes are hashed raw — several
    sources are PDFs and must not be parsed.
    """
    try:
        resp = httpx.get(url, follow_redirects=True, timeout=FETCH_TIMEOUT)
        return resp.status_code, resp.content, ""
    except Exception as exc:  # noqa: BLE001 - every failure must become a FAILED row
        return 0, b"", f"{type(exc).__name__}: {str(exc)[:200]}"


def classify(previous_hash: str | None, current_hash: str | None) -> str:
    """NEW (no baseline yet) | CHANGED | UNCHANGED | FAILED.

    Loaded directly by tests, so it stays a pure function of the hashes.
    """
    if current_hash is None:
        return "FAILED"
    if previous_hash is None:
        return "NEW"
    return "CHANGED" if previous_hash != current_hash else "UNCHANGED"


def fetch_sources(
    db, limit: int | None = None
) -> list[dict]:
    """Fetch every registered source (or the first `limit`), snapshot each, classify."""
    query = db.query(Source).order_by(Source.id)
    sources = query.limit(limit).all() if limit else query.all()

    results: list[dict] = []
    for source in sources:
        prev = (
            db.query(CrawlSnapshot)
            .filter(CrawlSnapshot.source_id == source.id)
            .order_by(CrawlSnapshot.fetched_at.desc())
            .first()
        )

        status, body, error = fetch_source(source.url)
        if not error and status >= 400:
            error = f"HTTP {status}"

        current_hash = None if error else sha256_bytes(body)
        kind = classify(prev.content_hash if prev else None, current_hash)

        db.add(
            CrawlSnapshot(
                source_id=source.id,
                content_hash=current_hash or "",
                http_status=status,
                bytes_len=len(body),
                error=error,
            )
        )
        db.flush()

        results.append(
            {
                "source_id": source.id,
                "publisher": source.publisher,
                "url": source.url,
                "kind": kind,
                "http_status": status,
                "bytes": len(body) if not error else 0,
                "error": error,
                "changed_from": prev.content_hash if prev and kind == "CHANGED" else None,
            }
        )
        db.commit()  # per source, so a late failure loses one row, not the run
    return results


def summarize(results: list[dict]) -> dict:
    counts: dict[str, int] = {}
    for r in results:
        counts[r["kind"]] = counts.get(r["kind"], 0) + 1
    return {"total": len(results), **counts}


def print_report(results: list[dict]) -> None:
    print(f"\n{'GovNavigator - source change detection':^66}")
    print("=" * 66)
    for r in results:
        kind = r["kind"]
        if kind == "FAILED":
            marker, state = FAIL, f"{RED}{r['error']}{RESET}"
        elif kind == "CHANGED":
            marker, state = WARN, f"CHANGED since last fetch ({r['http_status']} · {r['bytes']}B)"
        elif kind == "NEW":
            marker, state = OK, f"NEW baseline ({r['http_status']} · {r['bytes']}B)"
        else:
            marker, state = OK, f"unchanged ({r['http_status']} · {r['bytes']}B)"
        print(f"{marker} {r['publisher']:<28} {state}")
        print(f"       {DIM}{r['url']}{RESET}")
    print("=" * 66)
    stats = summarize(results)
    print(f"  {GREEN}{stats.get('total', 0)} sources{RESET} · "
          f"{GREEN}{stats.get('UNCHANGED', 0)} unchanged{RESET} · "
          f"{YELLOW}{stats.get('CHANGED', 0)} changed{RESET} · "
          f"{OK}{stats.get('NEW', 0)} new{RESET} · "
          f"{RED}{stats.get('FAILED', 0)} failed{RESET}")
    if stats.get("CHANGED"):
        print(f"\n  {YELLOW}Next step:{RESET} a source changed. Open docs/INGESTION.md — curate the")
        print("           change into the content JSON, PR it, and re-seed. The crawl never")
        print("           writes to what the public sees.")


def reembed(db) -> dict:
    """Re-embed every existing chunk (e.g. after an EMBEDDING_PROVIDER switch)."""
    chunks = db.query(Chunk).all()
    texts = [c.text for c in chunks]
    vectors, embedder, fallback = embed_with_fallback(texts)
    for chunk, vector in zip(chunks, vectors):
        chunk.embedding = vector
    db.commit()
    return {"chunks": len(chunks), "embedder": embedder.name, "fallback": fallback}


def main() -> int:
    parser = argparse.ArgumentParser(description="Source change detection (FR-10)")
    parser.add_argument("--limit", type=int, help="only fetch the first N sources")
    parser.add_argument("--json", metavar="FILE", help="write the report as JSON")
    parser.add_argument(
        "--reembed", action="store_true", help="re-embed existing chunks and stop"
    )
    args = parser.parse_args()

    init_db()
    db = SessionLocal()
    try:
        if args.reembed:
            result = reembed(db)
            print(f"{OK} re-embedded {result['chunks']} chunks with {result['embedder']}")
            if result["fallback"]:
                print(f"{WARN} {result['fallback']}")
            return 0

        started = time.perf_counter()
        results = fetch_sources(db, limit=args.limit)
        print_report(results)
        if args.json:
            report = {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "seconds": round(time.perf_counter() - started, 2),
                "summary": summarize(results),
                "sources": results,
            }
            with open(args.json, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2)
            print(f"{OK} wrote {len(results)} results to {args.json}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())