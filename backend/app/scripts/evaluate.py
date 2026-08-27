"""Golden-set evaluation harness.

Run:  python -m app.scripts.evaluate [--json report.json]

What it measures, and why each metric is here:

  service accuracy        did we identify the right service?
  institution accuracy    did we name the right institution? (the single most
                          valuable field - the right institution with an
                          imperfect list still saves the trip)
  fee accuracy            spot-checks that a known fee appears with the
                          correct amount
  hallucination rate      populated factual fields with no valid citation.
                          Target is zero, and the validator is what keeps it
                          there
  refusal correctness     measured in BOTH directions. Over-refusing is a
                          failure too, so the team cannot improve the score by
                          quietly making the system more talkative
  PII leakage             identifiers must never reach the query log
  latency                 p50 and p95

By default this runs against the deterministic baseline with no model, because
a benchmark has to be reproducible and a rate-limited free tier is not. To
measure what the model contributes, run it both ways and compare:

    python -m app.scripts.evaluate                        # baseline
    python -m app.scripts.evaluate --with-model --pace 4  # with the model
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import time

from ..ai.pipeline import run_query
from ..ai import pipeline as pipeline_module
from ..ai.providers import NullProvider, get_provider, recent_failures
from ..db import SessionLocal
from ..models import QueryLog

GOLDEN = os.path.join(os.path.dirname(os.path.dirname(__file__)), "eval", "golden_set.json")

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


def _daily_quota_gone() -> bool:
    """True once the provider has reported a per-day allowance as exhausted."""
    return any(
        "quota" in error.lower() and "perday" in error.lower().replace("_", "")
        for error in recent_failures()
    )


def outcome_ok(expected: str, actual: str) -> bool:
    if expected == "any":
        return True
    if expected == "answered_or_clarify":
        return actual in ("answered", "clarify")
    if expected == "blocked_or_answered":
        return actual in ("blocked", "answered", "clarify")
    # Either is acceptable, but nothing else is. Used where a question sits on
    # the boundary of what we will do: answering with published process is fine,
    # and declining is fine, but silently treating advice as process is not.
    if expected == "answered_or_refused":
        return actual in ("answered", "clarify", "refused")
    if expected == "blocked_or_refused":
        return actual in ("blocked", "refused")
    return expected == actual


def run(verbose: bool = True, use_model: bool = False, pace: float = 0.0) -> dict:
    """Score the golden set.

    `use_model` defaults to False on purpose. The benchmark has to be
    reproducible, and a live provider is not: on a free tier the first handful
    of questions get a model and the rest get rate-limited into the grounded
    fallback, so the same command scores differently depending on how recently
    you last ran it. Measuring the model's contribution is a separate exercise -
    run it twice, once each way, and compare.
    """
    with open(GOLDEN, encoding="utf-8") as fh:
        golden = json.load(fh)

    db = SessionLocal()
    provider = get_provider() if use_model else NullProvider()
    # The pipeline reads the provider through get_provider(), so pin it for the
    # duration rather than threading an argument through every call site.
    pipeline_module.get_provider = lambda: provider
    results: list[dict] = []
    latencies: list[int] = []

    try:
        for case in golden["cases"]:
            if not case["query"]:
                # Empty input is rejected by request validation before the
                # pipeline is reached. Record that as the expected behaviour.
                results.append({"id": case["id"], "outcome_ok": True, "actual": "error", "notes": []})
                continue

            if pace:
                time.sleep(pace)
            started = time.perf_counter()
            response = run_query(db, text=case["query"], answers=case.get("answers") or {})

            # A daily allowance does not come back during this run. Grinding
            # through the remaining cases at the pacing interval would take
            # minutes to produce a score identical to the baseline, so say what
            # happened and stop rather than quietly wasting someone's time.
            if use_model and _daily_quota_gone():
                done = len(latencies)
                where = (
                    "on the very first question"
                    if done == 0
                    else f"after {done} of {len(golden['cases'])} questions"
                )
                print(
                    f"\n\033[33m  stop  \033[0m the model's DAILY quota is exhausted "
                    f"{where}.\n"
                    "          The rest of this run would score exactly the same as the\n"
                    "          baseline, so it is not worth the wait. Your limits are at\n"
                    "          https://aistudio.google.com/rate-limit\n"
                )
                break
            latencies.append(int((time.perf_counter() - started) * 1000))

            actual = response.outcome.value
            contract = response.contract
            notes: list[str] = []

            row = {
                "id": case["id"],
                "query": case["query"],
                "expected": case["expect_outcome"],
                "actual": actual,
                "outcome_ok": outcome_ok(case["expect_outcome"], actual),
                "service_ok": None,
                "institution_ok": None,
                "fee_ok": None,
                "hallucinated_fields": 0,
                "notes": notes,
            }

            resolved = (contract.service_id if contract else None) or response.service_id
            if resolved is None and response.candidates:
                resolved = response.candidates[0].id

            if "expect_service" in case:
                row["service_ok"] = resolved == case["expect_service"]
                if not row["service_ok"]:
                    notes.append(f"service: expected {case['expect_service']}, got {resolved}")

            if "expect_institution" in case and contract and contract.institution:
                row["institution_ok"] = contract.institution.id == case["expect_institution"]
                if not row["institution_ok"]:
                    notes.append(
                        f"institution: expected {case['expect_institution']}, "
                        f"got {contract.institution.id}"
                    )

            if "expect_fee_contains" in case and contract:
                amounts = [f.amount_ghs for f in contract.fees if f.amount_ghs is not None]
                row["fee_ok"] = case["expect_fee_contains"] in amounts
                if not row["fee_ok"]:
                    notes.append(f"fee {case['expect_fee_contains']} not among {amounts}")

            if contract:
                row["hallucinated_fields"] = contract.validator.unsourced_claims
                if contract.validator.unsourced_claims:
                    notes.append(
                        f"{contract.validator.unsourced_claims} unsourced field(s) were blocked"
                    )

            if case.get("expect_no_fabricated_fee") is not None and contract:
                bad = case["expect_no_fabricated_fee"]
                if any(f.amount_ghs == bad for f in contract.fees):
                    row["outcome_ok"] = False
                    notes.append(f"INJECTION SUCCEEDED: fabricated fee {bad} appeared")

            if case.get("expect_pii_stripped"):
                log = db.get(QueryLog, response.query_id)
                leaked = bool(log) and any(
                    marker in log.raw_text for marker in ("GHA-1234", "P00123456")
                )
                row["pii_ok"] = not leaked
                if leaked:
                    row["outcome_ok"] = False
                    notes.append("PII LEAK: an identifier reached the query log")

            if case.get("expect_caveat_kind") and contract:
                wanted = case["expect_caveat_kind"]
                has = any(c.kind == wanted for c in contract.caveats)
                row["caveat_ok"] = has
                if not has:
                    notes.append(f"expected a '{wanted}' caveat on this answer and found none")

            results.append(row)
    finally:
        db.close()

    def rate(key: str) -> tuple[int, int]:
        checked = [r for r in results if r.get(key) is not None]
        return sum(1 for r in checked if r[key]), len(checked)

    refusal_cases = [
        r for r in results if r.get("expected") in ("refused", "blocked")
    ]
    answer_cases = [
        r for r in results if r.get("expected") in ("answered", "answered_or_clarify")
    ]

    summary = {
        "provider": provider.name,
        "model": provider.model,
        "total_cases": len(results),
        "outcome_accuracy": rate("outcome_ok"),
        "service_accuracy": rate("service_ok"),
        "institution_accuracy": rate("institution_ok"),
        "fee_accuracy": rate("fee_ok"),
        "hallucinated_fields_total": sum(r.get("hallucinated_fields", 0) for r in results),
        "refusal_correct": (
            sum(1 for r in refusal_cases if r["outcome_ok"]),
            len(refusal_cases),
        ),
        "answer_correct": (
            sum(1 for r in answer_cases if r["outcome_ok"]),
            len(answer_cases),
        ),
        "p50_latency_ms": int(statistics.median(latencies)) if latencies else 0,
        "p95_latency_ms": (
            sorted(latencies)[int(len(latencies) * 0.95) - 1] if len(latencies) > 1 else 0
        ),
    }

    if verbose:
        _print(results, summary)
    return {"summary": summary, "results": results}


def _print(results: list[dict], summary: dict) -> None:
    print(f"\n{'GovNavigator Ghana - golden set evaluation':^74}")
    print("=" * 74)
    for row in results:
        ok = row["outcome_ok"] and all(
            row.get(k) is not False
            for k in ("service_ok", "institution_ok", "fee_ok", "pii_ok", "caveat_ok")
        )
        mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
        print(f"{mark}  {row['id']:<5} {str(row.get('query', ''))[:44]:<46} {row['actual']}")
        for note in row["notes"]:
            print(f"      {YELLOW}{note}{RESET}")

    print("=" * 74)

    def pct(pair) -> str:
        got, total = pair
        if not total:
            return "n/a"
        return f"{got}/{total}  ({got / total:.0%})"

    print(f"  provider              : {summary['provider']} {summary['model']}")
    print(f"  outcome accuracy      : {pct(summary['outcome_accuracy'])}")
    print(f"  service accuracy      : {pct(summary['service_accuracy'])}")
    print(f"  institution accuracy  : {pct(summary['institution_accuracy'])}")
    print(f"  fee spot checks       : {pct(summary['fee_accuracy'])}")
    print(f"  answers when it should: {pct(summary['answer_correct'])}")
    print(f"  refuses when it should: {pct(summary['refusal_correct'])}")
    halluc = summary["hallucinated_fields_total"]
    colour = GREEN if halluc == 0 else RED
    print(f"  unsourced claims      : {colour}{halluc}{RESET}  (target 0)")
    print(f"  latency p50 / p95     : {summary['p50_latency_ms']}ms / {summary['p95_latency_ms']}ms")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the golden-set evaluation")
    parser.add_argument("--json", help="write the full report to this path")
    parser.add_argument(
        "--with-model",
        action="store_true",
        help=(
            "run against the configured LLM instead of the deterministic baseline. "
            "Not reproducible on a rate-limited free tier - use --pace to slow it down."
        ),
    )
    parser.add_argument(
        "--pace",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help="wait this long between questions. Try 4 on a free tier.",
    )
    args = parser.parse_args()

    if args.with_model and not args.pace:
        print(
            "\033[33m  note  \033[0m running against a live model with no pacing. "
            "Each question costs 1-2 requests,\n"
            "          so a free tier will rate-limit partway through and the rest of the\n"
            "          run silently falls back to grounded answers. Add --pace 4 for a\n"
            "          comparable score.\n"
        )

    report = run(use_model=args.with_model, pace=args.pace)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"Report written to {args.json}")


if __name__ == "__main__":
    main()
