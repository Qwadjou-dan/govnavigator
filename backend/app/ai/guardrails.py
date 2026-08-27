"""Guardrails: what stops this system from being confidently wrong.

Four independent mechanisms, applied in order:

1. Intake sanitisation — national identifiers are stripped before anything
   is stored or sent to a model provider (PRD §3.7, Act 843).
2. Scope gate — advice-seeking and circumvention queries are refused and
   routed, never generated.
3. Citation validation — every populated field must resolve to a source in
   the answer's own source list. Strict fields (fees, timelines, mandatory
   documents) additionally require an OFFICIAL source. Fields that fail are
   dropped and recorded, not quietly kept.
4. Freshness gate — fees and timelines older than the configured window are
   flagged "verify before you travel" rather than presented as current.

Design position: refusal is a feature, and it is measured. `eval/` tracks
refusal correctness in both directions, so the team cannot improve the
numbers by quietly making the system more talkative.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from ..config import settings
from ..schemas import (
    AnswerContract,
    Caveat,
    FieldStatus,
    Freshness,
    ValidatorReport,
)

# --------------------------------------------------------------------------
# 1. Intake sanitisation
# --------------------------------------------------------------------------

# Ghana Card: GHA-XXXXXXXXX-X. TIN: legacy 11-char starting with P/C/G/Q/V.
# Passport: letter + 7-8 digits. We are deliberately over-inclusive: a false
# positive costs a redacted token, a false negative costs a stored identifier.
_PII_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("ghana_card", re.compile(r"\bGHA[\s-]?\d{9}[\s-]?\d\b", re.I)),
    ("tin", re.compile(r"\b[PCGQV]\d{10}\b", re.I)),
    ("passport", re.compile(r"\b[GHKL]\d{7,8}\b", re.I)),
    ("ssnit", re.compile(r"\b[A-Z]\d{12}\b", re.I)),
    ("phone", re.compile(r"\b(?:\+233|0)\s?\d{2}\s?\d{3}\s?\d{4}\b")),
    ("long_digits", re.compile(r"\b\d{9,}\b")),
]

REDACTION = "[redacted]"


def strip_identifiers(text: str) -> tuple[str, list[str]]:
    """Remove anything that looks like a national identifier.

    Returns the cleaned text and the list of pattern names that fired, so the
    interface can tell the user honestly that we removed something.
    """
    found: list[str] = []
    cleaned = text
    for name, pattern in _PII_PATTERNS:
        if pattern.search(cleaned):
            found.append(name)
            cleaned = pattern.sub(REDACTION, cleaned)
    return cleaned, found


# Retrieved documents are untrusted input. A crawled page could contain text
# shaped like an instruction; it is evidence, never a command.
_INJECTION_PATTERNS = re.compile(
    r"(ignore (all |the )?(previous|above|prior) instructions"
    r"|disregard (the )?(system|previous)"
    r"|you are now"
    r"|new instructions:"
    r"|system prompt)",
    re.I,
)


def neutralise_injection(text: str) -> str:
    return _INJECTION_PATTERNS.sub("[removed instruction-like text]", text)


# --------------------------------------------------------------------------
# 2. Scope gate
# --------------------------------------------------------------------------

_ADVICE_PATTERNS = re.compile(
    r"(should i\b"
    r"|is it legal\b|is it illegal\b|am i allowed to (avoid|evade)"
    r"|how (do|can) i (avoid|evade|dodge|bypass|escape) (paying |the )?(tax|vat|duty|fee|permit|law)"
    r"|(avoid|evade) (paying )?tax"
    r"|without (paying|a) (the )?(permit|licence|license|fee|tax)"
    r"|fake (certificate|document|licence|license|passport)"
    r"|bribe|dash the officer|goro boy"
    r"|sue |lawsuit|take them to court|legal advice"
    r"|court case|my lawyer)",
    re.I,
)

BLOCK_MESSAGE = (
    "This looks like a request for legal, tax or professional advice, or for a way "
    "around a requirement. GovNavigator only explains official government processes "
    "— what an institution requires, what it costs and what order to follow. "
    "For advice on your specific situation, please speak to a qualified professional "
    "or contact the responsible institution directly."
)


def is_out_of_scope(text: str) -> bool:
    return bool(_ADVICE_PATTERNS.search(text))


# --------------------------------------------------------------------------
# 3. Citation validation
# --------------------------------------------------------------------------

# Fields where an unsourced or non-official claim causes real harm: a wrong
# fee sends someone to a counter with the wrong money.
STRICT_SECTIONS = {"fees", "timeline", "documents"}


def validate_contract(contract: AnswerContract) -> AnswerContract:
    """Drop every field that cannot be traced to a citation in this answer.

    Runs after assembly, whether the assembler was the deterministic one or a
    language model. That is the point: the validator does not trust its own
    caller.
    """
    report = ValidatorReport()
    valid_ids = {s.id for s in contract.sources}
    official_ids = {s.id for s in contract.sources if s.is_official}

    def check(section: str, item, label: str) -> bool:
        report.fields_checked += 1
        status = getattr(item, "status", FieldStatus.CONFIRMED)
        # Fields explicitly marked as "the institution does not publish this"
        # are a deliberate, honest statement rather than a claim of fact, so
        # they pass without a citation.
        if status in (
            FieldStatus.NOT_PUBLISHED,
            FieldStatus.VARIES_BY_LOCALITY,
        ):
            return True
        ref = getattr(item, "source_ref", None)
        if not ref or ref not in valid_ids:
            report.fields_dropped += 1
            report.unsourced_claims += 1
            report.dropped.append(f"{section}: {label} (no resolvable citation)")
            return False
        if section in STRICT_SECTIONS and ref not in official_ids:
            if status == FieldStatus.SECONDARY:
                # Allowed to survive, but the interface renders it as
                # "reported, not officially published".
                report.notes.append(f"{section}: {label} rests on a secondary source")
                return True
            report.fields_dropped += 1
            report.dropped.append(f"{section}: {label} (strict field, non-official source)")
            return False
        return True

    contract.eligibility = [
        i for i in contract.eligibility if check("eligibility", i, i.text[:60])
    ]
    contract.documents = [i for i in contract.documents if check("documents", i, i.name)]
    contract.steps = [i for i in contract.steps if check("steps", i, i.action[:60])]
    contract.fees = [i for i in contract.fees if check("fees", i, i.label)]
    if contract.timeline and not check("timeline", contract.timeline, "processing time"):
        contract.timeline = None

    report.strict_fields_ok = not any(
        d.startswith(tuple(f"{s}:" for s in STRICT_SECTIONS)) for d in report.dropped
    )
    contract.validator = report
    return contract


# --------------------------------------------------------------------------
# 4. Freshness gate
# --------------------------------------------------------------------------


def apply_freshness(contract: AnswerContract, today: date | None = None) -> AnswerContract:
    """Compare source dates against policy and attach honest caveats."""
    today = today or date.today()
    warn_before = today - timedelta(days=settings.freshness_warn_days)
    stale_before = today - timedelta(days=settings.freshness_stale_days)

    dates = [s.retrieved_at for s in contract.sources if s.retrieved_at]
    oldest = min(dates) if dates else None

    if oldest is None:
        contract.freshness = Freshness.VERIFY
    elif oldest < stale_before:
        contract.freshness = Freshness.STALE
    elif oldest < warn_before:
        contract.freshness = Freshness.VERIFY
    else:
        contract.freshness = Freshness.FRESH

    if contract.freshness != Freshness.FRESH:
        contract.caveats.append(
            Caveat(
                kind="freshness",
                text=(
                    "Some of the information behind this answer was last checked on "
                    f"{oldest.isoformat() if oldest else 'an unrecorded date'}. "
                    "Ghanaian fee schedules changed more than once in the last year — "
                    "confirm the amount at the official source before you travel or pay."
                ),
            )
        )

    # A fee shown without an effective date is exactly what unreliable blogs
    # publish. Say so rather than repeating the habit.
    undated_fees = [f.label for f in contract.fees if f.amount_ghs is not None and not f.effective_date]
    if undated_fees:
        contract.caveats.append(
            Caveat(
                kind="freshness",
                text=(
                    "The institution publishes these amounts without an effective date: "
                    + ", ".join(undated_fees)
                    + ". They are current as published, but there is no way to tell how "
                    "recently they were set."
                ),
            )
        )

    disputed = [f.label for f in contract.fees if f.status == FieldStatus.DISPUTED]
    if disputed:
        contract.caveats.append(
            Caveat(
                kind="dispute",
                text=(
                    "Official sources disagree about: "
                    + ", ".join(disputed)
                    + ". Both figures are shown with their sources so you can judge. "
                    "Confirm at the point of payment."
                ),
            )
        )

    varies = [f.label for f in contract.fees if f.status == FieldStatus.VARIES_BY_LOCALITY]
    if varies:
        contract.caveats.append(
            Caveat(
                kind="locality",
                text=(
                    "There is no single national amount for: "
                    + ", ".join(varies)
                    + ". Each Assembly sets its own rates each year in a fee-fixing "
                    "resolution, so you must ask your own Assembly for an assessment."
                ),
            )
        )
    return contract
