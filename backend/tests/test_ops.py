"""Phase 5 — ops tests: analytics, verification audit, ingest helpers.

Runs against the same session-seeded database as test_api.py (conftest). That
file verifies `nhis-registration` first, so these tests must not assume any
service is unverified — the audit flip test picks an open row dynamically.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


API = "/api"


def curator_headers(client) -> dict:
    """Curator bearer token via the dev credential (same as test_api)."""
    from app.config import settings

    token = client.post(
        f"{API}/auth/curator-login",
        json={"contact": settings.admin_email, "code": settings.admin_password},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------
# analytics
# --------------------------------------------------------------------------


def test_analytics_requires_curator(client):
    assert client.get(f"{API}/admin/analytics").status_code == 403


def test_analytics_shape(client):
    headers = curator_headers(client)
    data = client.get(f"{API}/admin/analytics?days=7", headers=headers).json()

    assert data["window_days"] == 7
    # Zero-filled: every day of the window appears, quiet or not.
    assert len(data["daily"]) == 8
    for row in data["daily"]:
        assert set(row) == {"date", "queries", "answered", "refused", "clarify", "blocked"}
        assert row["queries"] >= 0

    # The outcome split and the day series must tell the same story.
    assert set(data["outcome_split"]) == {"answered", "clarify", "refused", "blocked", "total"}
    assert sum(d["queries"] for d in data["daily"]) == data["outcome_split"]["total"]

    assert isinstance(data["top_services"], list)
    assert all({"service_id", "name", "queried"} <= set(s) for s in data["top_services"])
    assert isinstance(data["languages"], list)
    assert set(data["feedback_verdicts"]) == {"yes", "partly", "no"}


# --------------------------------------------------------------------------
# verification audit
# --------------------------------------------------------------------------


def test_audit_requires_curator(client):
    assert client.get(f"{API}/admin/verification-audit").status_code == 403


def test_audit_shape(client):
    headers = curator_headers(client)
    data = client.get(f"{API}/admin/verification-audit", headers=headers).json()

    summary, rows = data["summary"], data["rows"]
    assert summary["total"] >= 15
    assert summary["total"] == len(rows)
    assert summary["total"] == summary["verified"] + summary["unverified"]
    assert summary["needs_action"] <= summary["total"]

    # Everything the frontend renders must be present on every row.
    for r in rows:
        assert {"id", "name", "institution_abbr", "category", "coverage_tier",
                "reviewed", "source_count", "official_source_count",
                "freshness", "needs_action"} <= set(r)

    # The rule echoed in the runbook: unverified is always needs_action.
    for r in rows:
        if not r["reviewed"]:
            assert r["needs_action"] is True
    # A card can need action for another reason even when reviewed.
    assert summary["needs_action"] == sum(1 for r in rows if r["needs_action"])
    assert summary["verified"] == sum(1 for r in rows if r["reviewed"])

    # Sorted needs-action-first: once a row stops needing action, the rest do too.
    states = [r["needs_action"] for r in rows]
    assert states == sorted(states, reverse=True)


def test_verify_flips_audit(client):
    headers = curator_headers(client)
    data = client.get(f"{API}/admin/verification-audit", headers=headers).json()

    open_row = next((r for r in data["rows"] if not r["reviewed"]), None)
    if open_row is None:
        pytest.skip("every card was already verified by an earlier test")
    assert open_row["needs_action"] is True

    resp = client.post(
        f"{API}/admin/services/{open_row['id']}/verify", headers=headers
    ).json()
    assert resp["verified"] is True

    refreshed = client.get(f"{API}/admin/verification-audit", headers=headers).json()
    row = next(r for r in refreshed["rows"] if r["id"] == open_row["id"])
    assert row["reviewed"] is True
    assert row["reviewed_at"]
    assert refreshed["summary"]["verified"] == data["summary"]["verified"] + 1


# --------------------------------------------------------------------------
# ingest helpers (no network: the fetcher is stubbed)
# --------------------------------------------------------------------------


def test_ingest_helpers_no_network(monkeypatch, seeded):
    from app.db import SessionLocal
    from app.models import CrawlSnapshot, Source
    from app.scripts import ingest

    # classify is a pure function of the hashes.
    assert ingest.classify(None, "abc") == "NEW"
    assert ingest.classify("abc", "abc") == "UNCHANGED"
    assert ingest.classify("abc", "def") == "CHANGED"
    assert ingest.classify("abc", None) == "FAILED"
    assert ingest.sha256_bytes(b"x") == ingest.sha256_bytes(b"x")

    # summarize buckets the report.
    report = [{"kind": "NEW"}, {"kind": "CHANGED"}, {"kind": "UNCHANGED"}, {"kind": "FAILED"}]
    assert ingest.summarize(report) == {"total": 4, "NEW": 1, "CHANGED": 1, "UNCHANGED": 1, "FAILED": 1}

    # A run over the allow-list records snapshots and never touches content.
    def fake_fetch(url: str):
        return 200, b"govnavigator-test-body", ""

    monkeypatch.setattr(ingest, "fetch_source", fake_fetch)
    with SessionLocal() as db:
        before_services = db.query(Source).count()
        results = ingest.fetch_sources(db)
        assert len(results) == before_services
        assert db.query(CrawlSnapshot).count() >= before_services
        assert all(r["kind"] == "NEW" and not r["error"] for r in results)
        # Observational only — the sources table itself is untouched by a run.
        # (Snapshot rows are committed per source and stay; they are append-only
        # and nothing else in the suite reads them, so this is harmless.)
        assert db.query(Source).count() == before_services


def test_fetch_source_turns_raises_into_tuples(monkeypatch):
    """The isolation lives inside fetch_source: a network raise becomes a tuple."""
    import httpx

    from app.scripts import ingest

    def boom_get(*args, **kwargs):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "get", boom_get)
    status, body, error = ingest.fetch_source("https://example.com")
    assert status == 0
    assert body == b""
    assert "ConnectError" in error


def test_ingest_failures_are_banded_not_thrown(monkeypatch, seeded):
    """One broken source must never abort the run — it becomes a FAILED row."""
    from app.db import SessionLocal
    from app.models import CrawlSnapshot, Source
    from app.scripts import ingest

    def dead_fetch(url: str):  # respects the (status, body, error) contract
        return 0, b"", "ConnectError: site refused"

    monkeypatch.setattr(ingest, "fetch_source", dead_fetch)
    with SessionLocal() as db:
        before_snapshots = db.query(CrawlSnapshot).count()
        results = ingest.fetch_sources(db)
        assert len(results) == db.query(Source).count()
        assert all(r["kind"] == "FAILED" and r["error"] for r in results)
        assert db.query(CrawlSnapshot).count() == before_snapshots + len(results)