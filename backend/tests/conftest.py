"""One throwaway database, created before anything imports settings.

This has to live in conftest.py rather than in a test module. The engine is
built when app.db is first imported and binds to whatever DATABASE_URL held at
that instant, so two test modules each pointing at their own temporary file
would race: whichever imported second would set a URL nothing was listening to
and then seed a database the app was not using.

SQLite rather than Postgres is deliberate. It proves the dialect-adaptive
layer works and it means CI needs no services.
"""
from __future__ import annotations

import os
import tempfile

import pytest

_TMP = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP.name}"
os.environ["APP_ENV"] = "development"
# The limiter is per-process and these tests are much faster than a person.
os.environ["RATE_LIMIT_PER_MINUTE"] = "1000"
os.environ["RATE_LIMIT_BURST"] = "1000"
# Pin the suite to the deterministic grounded baseline regardless of what a
# developer's .env says. A live model (auto + a key) makes intent resolution
# non-deterministic and slow, which turns passing tests flaky — CI has no .env
# and runs baseline, so local runs must match that or they diverge.
os.environ["LLM_PROVIDER"] = "none"


@pytest.fixture(scope="session", autouse=True)
def seeded():
    from app.ai.retrieval import retriever
    from app.db import SessionLocal
    from app.scripts.seed import seed

    seed(reset=True)
    with SessionLocal() as db:
        retriever.refresh(db)
    yield
    # Best-effort only: on Windows the SQLite handle can still be open when the
    # session ends, and a failed unlink must not mask a passing suite.
    try:
        os.unlink(_TMP.name)
    except OSError:
        pass
