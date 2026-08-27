"""Application configuration.

Everything the app needs to run comes from environment variables, with
defaults that let the project start on a developer machine without any
external accounts. Nothing secret is ever committed: see .env.example.
"""
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # --- identity -----------------------------------------------------
    app_name: str = "GovNavigator Ghana"
    app_env: Literal["development", "staging", "production"] = "development"
    api_prefix: str = "/api"

    # --- database -----------------------------------------------------
    # Any SQLAlchemy URL. Production target is managed Postgres with the
    # pgvector extension (Neon / Supabase). SQLite works for local dev and
    # for CI; the retrieval layer adapts (see ai/retrieval.py).
    database_url: str = "postgresql+psycopg://postgres:devpass@localhost:5432/govnav"

    # --- security -----------------------------------------------------
    # Must be at least 32 bytes: PyJWT warns below that for HMAC-SHA256.
    # Refuses to boot in production while still set to this (see main.py).
    jwt_secret: str = "dev-only-not-a-secret-change-before-deploying-anywhere"
    jwt_algorithm: str = "HS256"
    session_ttl_hours: int = 24 * 14
    admin_email: str = "curator@govnavigator.local"
    admin_password: str = "changeme-in-production"
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # --- rate limiting ------------------------------------------------
    rate_limit_per_minute: int = 20
    rate_limit_burst: int = 8

    # --- AI providers -------------------------------------------------
    # The system is designed to run with NO provider key at all. In that
    # mode the deterministic grounded assembler answers from verified
    # service facts. Adding a key upgrades intent understanding and
    # phrasing; it never becomes a source of fact. See docs/AI_WORKFLOW.md.
    llm_provider: Literal["auto", "none", "openai", "anthropic", "gemini"] = "auto"
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    llm_model: str = ""
    llm_timeout_seconds: float = 20.0
    llm_max_output_tokens: int = 1200

    # "auto" resolves to "local" - see get_embedder() for why that is not an
    # oversight. Set "gemini" or "openai" explicitly to use a remote embedder,
    # and re-run seed afterwards so the stored vectors match.
    embedding_provider: Literal["auto", "local", "openai", "gemini"] = "auto"
    # Blank means the provider's current default. Embedding model ids are
    # retired like any other, so this must be overridable without a code change.
    embedding_model: str = ""
    embedding_dim: int = 384

    # --- retrieval tuning ---------------------------------------------
    retrieval_top_k: int = 8
    # Below this fused score we refuse rather than answer. This threshold is
    # the single most important safety dial in the system: raising it makes
    # the product quieter and safer, lowering it makes it chattier and more
    # dangerous. Tuned against eval/golden_set.json.
    relevance_floor: float = 0.45
    # A second candidate this close to the leader means the question is
    # genuinely ambiguous, so we ask instead of guessing.
    ambiguity_margin: float = 0.04

    # --- freshness ----------------------------------------------------
    # Days after which a fee or timeline is shown with a "verify before you
    # travel" flag. Ghanaian fee schedules moved twice in the last year, so
    # this is deliberately short.
    freshness_warn_days: int = 120
    freshness_stale_days: int = 240

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgres")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
