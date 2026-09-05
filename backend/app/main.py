"""GovNavigator Ghana — API entry point."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .ai.embeddings import get_embedder
from .ai.providers import PROMPT_VERSION, get_provider
from .ai.retrieval import retriever
from .config import settings
from .db import SessionLocal, init_db
from .routers import admin, auth, catalog, coverage, feedback, query

logging.basicConfig(
    level=logging.INFO,
    format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
)
log = logging.getLogger("govnavigator")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail loudly rather than run a public deployment on the shipped defaults.
    # This is the mistake that is easiest to make and most expensive to make.
    if settings.app_env == "production":
        insecure = []
        if settings.jwt_secret.startswith("dev-only"):
            insecure.append("JWT_SECRET")
        if "change-me" in settings.admin_password or settings.admin_password == "changeme-in-production":
            insecure.append("ADMIN_PASSWORD")
        if insecure:
            raise RuntimeError(
                "Refusing to start in production with default "
                + " and ".join(insecure)
                + ". Set real values - see docs/DEPLOYMENT.md."
            )
        if len(settings.jwt_secret) < 32:
            raise RuntimeError("JWT_SECRET must be at least 32 characters.")

    init_db()
    db = SessionLocal()
    try:
        retriever.refresh(db)
        log.info("retrieval index loaded: %d services", len(retriever.service_meta))
    finally:
        db.close()
    log.info("llm provider=%s embedder=%s", get_provider().name, get_embedder().name)
    yield


app = FastAPI(
    title="GovNavigator Ghana API",
    version="0.3.0",
    description=(
        "An AI navigator for Ghanaian government services. Answers are assembled from "
        "verified official sources and validated against their citations. The system "
        "declines rather than guesses."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def observability(request: Request, call_next):
    """NFR-4: every request is traced with a latency figure."""
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:  # noqa: BLE001
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={
                "detail": (
                    "Something went wrong on our side. Nothing you typed was lost. "
                    "Please try again, and if this keeps happening go to the official "
                    "institution page directly."
                )
            },
        )
    elapsed = int((time.perf_counter() - started) * 1000)
    response.headers["X-Response-Time-ms"] = str(elapsed)
    log.info(
        "%s %s -> %s (%dms)", request.method, request.url.path, response.status_code, elapsed
    )
    return response


@app.get("/health", tags=["ops"])
def health() -> dict:
    return {"status": "ok", "env": settings.app_env}


@app.get(f"{settings.api_prefix}/system", tags=["ops"])
def system() -> dict:
    """What this deployment is actually running. Shown in the UI footer so the
    grounding claims are checkable rather than decorative."""
    provider = get_provider()
    embedder = get_embedder()
    return {
        "app": settings.app_name,
        "env": settings.app_env,
        "llm_provider": provider.name,
        "llm_model": provider.model,
        "llm_mode": (
            "grounded-only (no model configured; answers come from verified content)"
            if provider.name == "none"
            else "model-assisted intent and phrasing; facts remain source-bound"
        ),
        "embedder": embedder.name,
        "embedding_dim": embedder.dim,
        "prompt_version": PROMPT_VERSION,
        "database": "postgresql+pgvector" if settings.is_postgres else "sqlite",
        "services_indexed": len(retriever.service_meta),
        "relevance_floor": settings.relevance_floor,
    }


for r in (
    query.router,
    catalog.router,
    auth.router,
    auth.checklists,
    feedback.router,
    coverage.router,
    admin.router,
):
    app.include_router(r, prefix=settings.api_prefix)
