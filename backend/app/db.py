"""Database engine, session and the dialect-adaptive embedding column."""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import JSON, create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import settings

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(
    settings.database_url,
    # Hosted Postgres providers close idle connections without telling us. Both
    # of these exist to make that invisible: recycle retires a connection before
    # the provider does, and pre_ping catches the ones that slip through. The
    # ping costs a round trip per checkout, which is worth paying to avoid a
    # dropped-connection error in the middle of a demonstration.
    pool_pre_ping=True,
    pool_recycle=280,
    future=True,
    connect_args=connect_args,
)

# expire_on_commit=False: by default SQLAlchemy discards every loaded value at
# commit, so touching any attribute afterwards silently issues a fresh SELECT.
# In a request that commits a log row and then reads the service it just
# answered about, that is several extra network round trips for data we already
# have. Sessions here are short and request-scoped, so nothing outlives the
# request long enough to go stale.
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
    future=True,
)


class Base(DeclarativeBase):
    pass


class Embedding(TypeDecorator):
    """Stores a vector as pgvector on Postgres and as JSON everywhere else.

    Keeping this behind one type means the rest of the codebase never has to
    care which database it is talking to. On Postgres the column is a real
    `vector(N)`, so an ivfflat/HNSW index can be added later without a
    migration of the application code (see docs/DEPLOYMENT.md).
    """

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            try:
                from pgvector.sqlalchemy import Vector

                return dialect.type_descriptor(Vector(settings.embedding_dim))
            except ImportError:  # pragma: no cover - pgvector always installed in prod
                pass
        return dialect.type_descriptor(JSON())

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return list(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        # pgvector hands back a numpy array. Coerce to plain Python floats at
        # this boundary: numpy scalars travel silently through the whole
        # pipeline and then fail at JSON serialisation, far from the cause.
        return [float(x) for x in value]


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables, and the pgvector extension when running on Postgres."""
    if settings.is_postgres:
        from sqlalchemy import text

        with engine.begin() as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    from . import models  # noqa: F401  (registers mappers)

    Base.metadata.create_all(bind=engine)
