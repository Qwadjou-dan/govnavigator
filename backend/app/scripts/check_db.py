"""Database doctor.

Run:  python -m app.scripts.check_db

Checks your DATABASE_URL end to end and tells you in plain language what is
wrong and how to fix it. A raw SQLAlchemy traceback is sixty lines that all
say "connection failed" — this says which of the four likely causes it is.

Checks, in order:
  1. Is DATABASE_URL set, and is the scheme one the installed drivers support?
  2. Can we actually open a connection?
  3. (Postgres) Is the pgvector extension installed? Offer to install it.
  4. Do the tables exist, and is there content in them?
  5. How far away is the database, and what does that cost per answer?
  6. (Postgres) Is `chunks.embedding` a real vector column, not JSON?
"""
from __future__ import annotations

import sys
import time

# A doctor that dies of the disease is no use. If the dependencies are not
# importable, say so in plain language instead of raising ModuleNotFoundError.
try:
    from sqlalchemy import inspect, text

    from ..config import settings
except ModuleNotFoundError as exc:  # pragma: no cover - environment problem
    missing = getattr(exc, "name", "a required package")
    print(f"\n\033[31m fail \033[0m '{missing}' is not installed in the Python you are running.")
    print(f"\n\033[33mHow to fix\033[0m  Almost always this means the virtualenv is active but the")
    print("           packages were never installed into it. From the backend folder:")
    print("\n           \033[36msource .venv/bin/activate\033[0m")
    print("           \033[36mpip install -r requirements.txt\033[0m")
    print("\n           Check which Python you are actually using with:")
    print("           \033[36mpip -V\033[0m")
    print("           The path it prints should end in backend/.venv. If it does not,")
    print("           you have a different virtualenv active than you think.\n")
    sys.exit(1)

GREEN, RED, YELLOW, BLUE, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[0m",
)
OK, FAIL, WARN = f"{GREEN}  ok  {RESET}", f"{RED} fail {RESET}", f"{YELLOW} warn {RESET}"


def _redact(url: str) -> str:
    """Never print a password, including into a screenshot in a group chat."""
    if "@" not in url or "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)
    user = creds.split(":", 1)[0]
    return f"{scheme}://{user}:****@{host}"


def _fix(message: str, *lines: str) -> None:
    print(f"\n{YELLOW}How to fix{RESET}  {message}")
    for line in lines:
        print(f"           {BLUE}{line}{RESET}")


def main() -> int:  # noqa: C901 - a linear checklist reads better than helpers
    url = settings.database_url
    print(f"\n{'GovNavigator - database check':^66}")
    print("=" * 66)
    print(f"  DATABASE_URL  {_redact(url)}\n")

    # -- 1. scheme ---------------------------------------------------------
    if not url:
        print(f"{FAIL} DATABASE_URL is empty")
        _fix("Set it in backend/.env:", "DATABASE_URL=sqlite:///./govnav.db")
        return 1

    if url.startswith("postgresql://") or url.startswith("postgres://"):
        print(f"{FAIL} the URL is missing the driver in its scheme")
        _fix(
            "Neon and Supabase hand you a URL starting postgresql://. SQLAlchemy needs "
            "to be told which driver to use, so rewrite the scheme:",
            "postgresql+psycopg://user:pass@host/db?sslmode=require",
            "            ^^^^^^^ add this",
        )
        return 1

    if url.startswith("postgresql+psycopg2://"):
        print(f"{FAIL} psycopg2 is not installed - this project uses psycopg 3")
        _fix("Change +psycopg2 to +psycopg in your DATABASE_URL.")
        return 1

    is_pg = settings.is_postgres
    print(f"{OK} scheme looks right ({'PostgreSQL' if is_pg else 'SQLite'})")

    # -- 2. connect --------------------------------------------------------
    try:
        from ..db import engine

        with engine.connect() as conn:
            if is_pg:
                version = conn.execute(text("SELECT version()")).scalar() or ""
                print(f"{OK} connected - {version.split(',')[0]}")
            else:
                conn.execute(text("SELECT 1"))
                print(f"{OK} connected")
    except Exception as exc:  # noqa: BLE001 - the whole point is to explain it
        detail = str(exc).lower()
        print(f"{FAIL} could not connect")
        # psycopg 3 says "failed to resolve host"; psycopg2 said "could not
        # translate host name". Match both, plus the raw getaddrinfo wording.
        if any(
            phrase in detail
            for phrase in (
                "failed to resolve host",
                "could not translate host name",
                "name or service not known",
                "no address associated with hostname",
                "nodename nor servname",
            )
        ):
            _fix(
                "The host in your URL does not resolve. Check for a typo, and make sure "
                "you copied the whole connection string from your provider."
            )
        elif "connection refused" in detail:
            _fix(
                "Nothing is listening there. If the host is localhost you are pointing at "
                "a local Postgres that is not running. Either start it, or use your "
                "hosted URL, or switch to SQLite:",
                "DATABASE_URL=sqlite:///./govnav.db",
            )
        elif "password authentication failed" in detail or "authentication" in detail:
            _fix(
                "The username or password is wrong. Re-copy the connection string from "
                "your provider's dashboard - passwords are often shown only once, and a "
                "password containing @ / : must be percent-encoded."
            )
        elif "ssl" in detail:
            _fix("The server requires SSL. Append ?sslmode=require to the URL.")
        elif "timeout" in detail or "timed out" in detail:
            _fix(
                "The connection timed out. Check your internet, and whether your provider "
                "restricts access by IP address."
            )
        elif "does not exist" in detail:
            _fix("That database name does not exist on the server. Check the last path segment of the URL.")
        else:
            print(f"\n{DIM}{str(exc)[:400]}{RESET}")
            _fix("See the message above.")
        return 1

    # -- 3. pgvector -------------------------------------------------------
    if is_pg:
        try:
            with engine.connect() as conn:
                installed = conn.execute(
                    text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
                ).scalar()
            if installed:
                print(f"{OK} pgvector extension is installed")
            else:
                print(f"{WARN} pgvector is not installed yet - installing it now")
                with engine.begin() as conn:
                    conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
                print(f"{OK} pgvector installed")
        except Exception as exc:  # noqa: BLE001
            print(f"{FAIL} pgvector is not available on this database")
            _fix(
                "Run this once in your provider's SQL editor:",
                "CREATE EXTENSION IF NOT EXISTS vector;",
                "",
                "Neon and Supabase both support it. If your provider does not, use SQLite "
                "for now - the app runs identically on it.",
            )
            print(f"\n{DIM}{str(exc)[:300]}{RESET}")
            return 1

    # -- 4. schema and content --------------------------------------------
    expected = {"institutions", "services", "sources", "chunks"}
    tables = set(inspect(engine).get_table_names())
    missing = expected - tables

    if missing:
        print(f"{WARN} tables not created yet: {', '.join(sorted(missing))}")
        _fix("Seed the database:", "python -m app.scripts.seed --reset")
        return 1
    print(f"{OK} all {len(tables)} tables exist")

    with engine.connect() as conn:
        counts = {
            name: conn.execute(text(f"SELECT count(*) FROM {name}")).scalar() or 0
            for name in ("institutions", "sources", "services", "chunks")
        }
    if counts["services"] == 0 or counts["chunks"] == 0:
        print(f"{WARN} tables are empty")
        _fix("Load the knowledge base:", "python -m app.scripts.seed --reset")
        return 1
    print(
        f"{OK} content loaded - {counts['services']} services, {counts['institutions']} "
        f"institutions, {counts['sources']} sources, {counts['chunks']} chunks"
    )

    # -- 5. how far away is this database? ---------------------------------
    # The single most common cause of "the app got slower" is moving from a
    # local file to a database across the internet. One answer needs a handful
    # of queries, so the round-trip time is multiplied by roughly ten.
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))  # warm the connection, then measure
        samples = []
        for _ in range(5):
            start = time.perf_counter()
            conn.execute(text("SELECT 1"))
            samples.append((time.perf_counter() - start) * 1000)
    rtt = sorted(samples)[len(samples) // 2]
    budget = rtt * 9  # what one answered question costs in waiting alone

    if rtt < 5:
        print(f"{OK} round trip {rtt:.1f}ms - this database is local")
    elif rtt < 60:
        print(f"{OK} round trip {rtt:.0f}ms - about {budget/1000:.1f}s per answer in waiting")
    else:
        print(f"{WARN} round trip {rtt:.0f}ms - roughly {budget/1000:.1f}s of every answer is network wait")
        _fix(
            "The database is far away. Nothing is broken, but each answer pays this "
            "about nine times over. Options, cheapest first:",
            "1. Pick a region closer to you when creating the database (eu-west or",
            "   eu-central are much closer to Ghana than us-east).",
            "2. If you are on a serverless tier that sleeps when idle, the FIRST",
            "   question after a pause also pays a cold start of several seconds.",
            "   Ask one question a minute before you demonstrate.",
            "3. For the demonstration itself, SQLite is local and instant:",
            "   DATABASE_URL=sqlite:///./govnav.db  then re-run seed --reset",
        )

    # -- 6. is the embedding column a real vector? -------------------------
    if is_pg:
        with engine.connect() as conn:
            col_type = conn.execute(
                text(
                    "SELECT udt_name FROM information_schema.columns "
                    "WHERE table_name = 'chunks' AND column_name = 'embedding'"
                )
            ).scalar()
        if col_type == "vector":
            print(f"{OK} chunks.embedding is a native pgvector column")
        else:
            print(f"{WARN} chunks.embedding is '{col_type}', not 'vector'")
            _fix(
                "The tables were created before pgvector was available, so the column "
                "fell back to JSON. Recreate them:",
                "python -m app.scripts.seed --reset",
            )
            return 1

    # -- summary -----------------------------------------------------------
    print("=" * 66)
    print(f"  {GREEN}Everything checks out.{RESET} Start the API with:")
    print(f"  {BLUE}uvicorn app.main:app --reload --port 8000{RESET}")
    if is_pg and counts["chunks"] > 500:
        print(
            f"\n  {DIM}Corpus is getting large. Consider an index:\n"
            f"  CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);{RESET}"
        )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
