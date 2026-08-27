"""Model doctor.

Run:  python -m app.scripts.check_llm

The model layer is designed to fail quietly: if a provider call does not come
back, the answer is still assembled from verified content and the person sees a
correct, cited card. That is the right behaviour in production and a terrible
one while you are setting a key up, because a wrong key, a shut-down model id
and no key at all all look identical from the outside - the app simply carries
on without a model.

This makes one real call and says exactly what happened.
"""
from __future__ import annotations

import sys

try:
    from ..ai.prompts import CONDITIONS_SCHEMA_HINT, CONDITIONS_SYSTEM
    from ..ai.providers import get_provider
    from ..config import settings
except ModuleNotFoundError as exc:  # pragma: no cover - environment problem
    missing = getattr(exc, "name", "a required package")
    print(f"\n\033[31m fail \033[0m '{missing}' is not installed in the Python you are running.")
    print("\n\033[33mHow to fix\033[0m  From the backend folder:")
    print("           \033[36msource .venv/bin/activate\033[0m")
    print("           \033[36mpip install -r requirements.txt\033[0m\n")
    sys.exit(1)

GREEN, RED, YELLOW, BLUE, DIM, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[36m", "\033[2m", "\033[0m",
)
OK, FAIL, WARN = f"{GREEN}  ok  {RESET}", f"{RED} fail {RESET}", f"{YELLOW} warn {RESET}"


def _fix(message: str, *lines: str) -> None:
    print(f"\n{YELLOW}How to fix{RESET}  {message}")
    for line in lines:
        print(f"           {BLUE}{line}{RESET}")


def main() -> int:
    print(f"\n{'GovNavigator - model check':^66}")
    print("=" * 66)

    keys = {
        "GEMINI_API_KEY": settings.gemini_api_key,
        "OPENAI_API_KEY": settings.openai_api_key,
        "ANTHROPIC_API_KEY": settings.anthropic_api_key,
    }
    for name, value in keys.items():
        # Enough to tell two keys apart, never enough to use one.
        print(f"  {name:<20} {(value[:6] + '...' + value[-4:]) if value else '(not set)'}")
    print(f"  LLM_PROVIDER         {settings.llm_provider}")
    print(f"  LLM_MODEL            {settings.llm_model or '(provider default)'}\n")

    provider = get_provider()

    if provider.name == "none":
        print(f"{WARN} no model configured - running in grounded-only mode")
        if not any(keys.values()):
            _fix(
                "This is a supported mode: answers are still correct and cited. To add a "
                "model, get a free key at https://aistudio.google.com/apikey and put it in "
                "backend/.env:",
                "GEMINI_API_KEY=your-key-here",
            )
        else:
            _fix(
                "A key is set but no provider was selected. Check LLM_PROVIDER - it should "
                "be 'auto' or the name of the provider whose key you set.",
                "LLM_PROVIDER=auto",
            )
        return 1

    print(f"{OK} provider selected: {provider.name} / {provider.model}")
    print(f"{DIM}      making one real call...{RESET}")

    result = provider.complete_json(
        CONDITIONS_SYSTEM,
        'Question: I need a card for my brother who lives in London\n\n'
        'Choices that are still open:\n'
        '- id "where": Where will the person being registered be?\n'
        '    value "in_ghana" means In Ghana\n'
        '    value "abroad" means Outside Ghana',
        CONDITIONS_SCHEMA_HINT,
    )

    if not result.ok:
        detail = result.error.lower()
        print(f"{FAIL} the call failed")
        if "404" in detail or "not found" in detail:
            _fix(
                f"'{provider.model}' was rejected. Model ids get retired - this is the most "
                "common cause once a key is working. Pin a current one in backend/.env:",
                "LLM_MODEL=gemini-3.5-flash",
                "",
                "The current list is at https://ai.google.dev/gemini-api/docs/models",
            )
        elif "401" in detail or "403" in detail or "api key" in detail or "permission" in detail:
            _fix(
                "The key was rejected. Re-copy it from https://aistudio.google.com/apikey - "
                "and check you have not pasted quotes or a trailing space into .env."
            )
        elif "429" in detail or "quota" in detail or "resource_exhausted" in detail:
            if "perday" in detail.replace("_", "") or "per day" in detail:
                _fix(
                    "That is your DAILY allowance for this model, and it does not clear by "
                    "waiting - it resets on Google's schedule. Until then the app keeps "
                    "working: answers come from verified content and are still cited. "
                    "Options:",
                    "1. See your actual limits at https://aistudio.google.com/rate-limit",
                    "2. Switch to a model with a larger free allowance:",
                    "   LLM_MODEL=gemini-3.5-flash-lite",
                    "3. Wait for the reset, and avoid --with-model evaluation runs, which",
                    "   spend the allowance dozens of questions at a time.",
                )
            else:
                _fix(
                    "You are over the per-minute rate limit. It clears within a minute. The "
                    "app keeps working in the meantime - it falls back to grounded answers."
                )
        elif "timeout" in detail or "timed out" in detail or "connect" in detail:
            _fix(
                "Could not reach the provider. Check your internet connection, then raise the "
                "timeout if your connection is slow:",
                "LLM_TIMEOUT_SECONDS=40",
            )
        else:
            print(f"\n{DIM}{result.error[:400]}{RESET}")
            _fix("See the message above.")
        return 1

    print(f"{OK} the call succeeded ({result.tokens} tokens)")

    settled = (result.data or {}).get("settled") or {}
    if settled.get("where") == "abroad":
        print(f"{OK} it read 'lives in London' correctly as {BLUE}where = abroad{RESET}")
    else:
        print(f"{WARN} it did not read the condition out of the question")
        print(f"{DIM}      returned: {result.data}{RESET}")
        _fix(
            "The call works, so this is a quality problem rather than a setup one. A "
            "stronger model handles it better:",
            "LLM_MODEL=gemini-3.7-flash",
        )
        return 1

    print("=" * 66)
    print(f"  {DIM}Each question costs one model call, sometimes two. Free tiers are")
    print(f"  rated per minute, so a burst - the evaluation harness, or a demo where")
    print(f"  several people type at once - can hit the limit. Nothing breaks when it")
    print(f"  does: the answer falls back to verified content, which is already cited.{RESET}\n")
    print(f"  {GREEN}The model is working.{RESET} Ask a question with a condition in it, e.g.")
    print(f"  {BLUE}\"can I get a Ghana Card for my brother who is abroad\"{RESET}")
    print("  and the card should answer it directly rather than only listing steps.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
