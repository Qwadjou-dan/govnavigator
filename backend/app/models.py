"""Database models.

Design note on privacy (PRD §3.7, Ghana Data Protection Act, Act 843):
there is deliberately NO column anywhere in this schema capable of holding a
Ghana Card number, TIN, passport number or any other national identifier.
A privacy promise that lives only in a policy document tends not to survive
a deadline. A schema with nowhere to put the data is a promise that holds.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, Embedding


def _uuid() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Knowledge layer
# ---------------------------------------------------------------------------


class Institution(Base):
    """An MDA, MMDA or statutory agency. Also the Tier 2 directory."""

    __tablename__ = "institutions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    abbreviation: Mapped[str] = mapped_column(String(32), default="")
    mandate: Mapped[str] = mapped_column(Text, default="")
    official_url: Mapped[str] = mapped_column(String(512), default="")
    portal_url: Mapped[str] = mapped_column(String(512), default="")
    phone: Mapped[str] = mapped_column(String(255), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    head_office: Mapped[str] = mapped_column(Text, default="")
    digital_address: Mapped[str] = mapped_column(String(64), default="")
    opening_hours: Mapped[str] = mapped_column(String(255), default="")
    offices: Mapped[list] = mapped_column(JSON, default=list)
    coverage_tier: Mapped[int] = mapped_column(Integer, default=2)
    notes: Mapped[str] = mapped_column(Text, default="")

    services: Mapped[list["Service"]] = relationship(back_populates="institution")


class Source(Base):
    """The allow-list of publishers we are permitted to cite.

    `is_official` drives strict validation: a fee, timeline or mandatory
    document may only be shown when its citation resolves to an official
    source. Secondary sources can support context, never a hard fact.
    """

    __tablename__ = "sources"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(512))
    publisher: Mapped[str] = mapped_column(String(255))
    url: Mapped[str] = mapped_column(String(1024))
    is_official: Mapped[bool] = mapped_column(Boolean, default=True)
    retrieved_at: Mapped[date] = mapped_column(Date)
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(Text, default="")


class Service(Base):
    """A citizen- or business-facing government service (a 'service card')."""

    __tablename__ = "services"

    id: Mapped[str] = mapped_column(String(96), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    short_name: Mapped[str] = mapped_column(String(128), default="")
    category: Mapped[str] = mapped_column(String(64), index=True)
    summary: Mapped[str] = mapped_column(Text, default="")
    institution_id: Mapped[str] = mapped_column(ForeignKey("institutions.id"))
    dependent_institution_ids: Mapped[list] = mapped_column(JSON, default=list)
    aliases: Mapped[list] = mapped_column(JSON, default=list)
    keywords: Mapped[list] = mapped_column(JSON, default=list)
    coverage_tier: Mapped[int] = mapped_column(Integer, default=1)

    eligibility: Mapped[list] = mapped_column(JSON, default=list)
    documents: Mapped[list] = mapped_column(JSON, default=list)
    steps: Mapped[list] = mapped_column(JSON, default=list)
    fees: Mapped[list] = mapped_column(JSON, default=list)
    timeline: Mapped[dict] = mapped_column(JSON, default=dict)
    rejection_causes: Mapped[list] = mapped_column(JSON, default=list)
    caveats: Mapped[list] = mapped_column(JSON, default=list)
    clarifiers: Mapped[list] = mapped_column(JSON, default=list)
    related_service_ids: Mapped[list] = mapped_column(JSON, default=list)
    source_ids: Mapped[list] = mapped_column(JSON, default=list)

    content_version: Mapped[int] = mapped_column(Integer, default=1)
    reviewed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    institution: Mapped[Institution] = relationship(back_populates="services")
    chunks: Mapped[list["Chunk"]] = relationship(
        back_populates="service", cascade="all, delete-orphan"
    )


class Chunk(Base):
    """A retrievable passage of evidence, tagged to a service and a source."""

    __tablename__ = "chunks"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(ForeignKey("services.id"), index=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("sources.id"))
    section: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer, default=0)
    effective_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    embedding: Mapped[list | None] = mapped_column(Embedding, nullable=True)

    service: Mapped[Service] = relationship(back_populates="chunks")


# ---------------------------------------------------------------------------
# Identity — deliberately minimal
# ---------------------------------------------------------------------------


class User(Base):
    """A lightweight account used only to save checklists, plus curators.

    We store a hash of the contact, not the contact itself, except for
    curator accounts which need a login. No national identifiers, ever.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    contact_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_label: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(16), default="citizen")  # citizen | curator
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OneTimeCode(Base):
    __tablename__ = "one_time_codes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    contact_hash: Mapped[str] = mapped_column(String(64), index=True)
    code_hash: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)


class SavedChecklist(Base):
    __tablename__ = "saved_checklists"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    service_id: Mapped[str] = mapped_column(String(96))
    title: Mapped[str] = mapped_column(String(255))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    progress: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (UniqueConstraint("user_id", "service_id", name="uq_user_service"),)


# ---------------------------------------------------------------------------
# Observability and learning
# ---------------------------------------------------------------------------


class QueryLog(Base):
    """One row per answered (or refused) question. NFR-4 observability.

    `raw_text` is stored after PII stripping so the corpus of real phrasings
    can drive the intent taxonomy, and is not linked to a user id.
    """

    __tablename__ = "query_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    raw_text: Mapped[str] = mapped_column(Text)
    normalised_text: Mapped[str] = mapped_column(Text, default="")
    detected_language: Mapped[str] = mapped_column(String(32), default="en")
    outcome: Mapped[str] = mapped_column(String(32), index=True)  # answered|clarify|refused|blocked
    resolved_service_id: Mapped[str | None] = mapped_column(String(96), nullable=True)
    coverage_tier: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confidence: Mapped[str | None] = mapped_column(String(16), nullable=True)
    top_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    retrieved_chunk_ids: Mapped[list] = mapped_column(JSON, default=list)
    llm_provider: Mapped[str] = mapped_column(String(32), default="none")
    llm_model: Mapped[str] = mapped_column(String(64), default="")
    prompt_version: Mapped[str] = mapped_column(String(32), default="")
    validator_report: Mapped[dict] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    token_cost: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class AnswerLog(Base):
    """The exact Answer Contract served, kept for audit (PRD §7.4)."""

    __tablename__ = "answer_logs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    query_id: Mapped[str] = mapped_column(ForeignKey("query_logs.id"), index=True)
    service_id: Mapped[str | None] = mapped_column(String(96), nullable=True)
    contract: Mapped[dict] = mapped_column(JSON, default=dict)
    content_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    answer_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    service_id: Mapped[str | None] = mapped_column(String(96), index=True, nullable=True)
    verdict: Mapped[str] = mapped_column(String(16))  # yes | partly | no
    comment: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="open")  # open | resolved | dismissed
    curator_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    resolution: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class CoverageRequest(Base):
    """A Tier 3 miss. The ranked backlog of what to verify next comes from
    real users rather than from our assumptions."""

    __tablename__ = "coverage_requests"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    query_text: Mapped[str] = mapped_column(Text)
    suggested_institution_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    count: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
