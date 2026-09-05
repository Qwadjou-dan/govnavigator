"""In-process conversation memory.

The product is "one question, one cited answer" — but a person rarely lands
with a complete sentence. They ask "how do I register my business" and then
"how much?" — the second sentence has no service in it, yet answering it means
remembering the first. This store keeps just enough per session to do that:
the last service a turn actually settled on, the branch choices that were
resolved, and a short list of the turns themselves for the UI.

Deliberately tiny and deliberately in-memory. Persisting conversation state
would turn transient user data into a system of record; the audit trail
already lives in ``QueryLog``, which is what the curator console reads. An
in-memory store is lost on restart, which is acceptable — a person who reloads
the page and keeps talking gets the same neutral treatment they would from a
counter clerk who does not remember them — and the security posture stays
simple: no PII, nothing written to disk, bounded size, everything expired.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field

MAX_TURNS = 12
MAX_SESSIONS = 512
# A working day. Anything older is treated as a new conversation, so a phone
# left open on a checkout counter does not later steer a stranger's follow-up.
TURN_TTL_SECONDS = 4 * 60 * 60


@dataclass
class Turn:
    question: str
    query_id: str
    outcome: str
    service_id: str | None = None
    service_name: str | None = None


@dataclass
class Conversation:
    session_id: str
    turns: list[Turn] = field(default_factory=list)
    last_service_id: str | None = None
    last_service_name: str | None = None
    # Branch choices that were settled (clarifier id -> option value). Carried
    # into a follow-up so "how much?" stays on the same branch as the question
    # it continues — a renewal fee is not the registration fee.
    answers: dict[str, str] = field(default_factory=dict)
    touched: float = field(default_factory=time.time)

    @property
    def has_answered_context(self) -> bool:
        """A follow-up can only continue from a turn that settled on a service.

        Clarify turns that resolved a service count too: once we have bound the
        question to one card, "with my brother as a partner" belongs to that
        card. Refusals and blocks do not settle anything, so a dead end never
        becomes a preference.
        """
        return self.last_service_id is not None


class ConversationStore:
    """Thread-safe, size-bounded map of ``session_id`` -> :class:`Conversation`."""

    def __init__(self, *, max_sessions: int = MAX_SESSIONS) -> None:
        self._sessions: dict[str, Conversation] = {}
        self._max = max_sessions
        self._lock = threading.Lock()

    def get(self, session_id: str) -> Conversation | None:
        with self._lock:
            conv = self._sessions.get(session_id)
            if conv is None:
                return None
            if time.time() - conv.touched > TURN_TTL_SECONDS:
                self._sessions.pop(session_id, None)
                return None
            return conv

    def _get_or_create(self, session_id: str) -> Conversation:
        if self._max and len(self._sessions) >= self._max:
            oldest = min(self._sessions.values(), key=lambda c: c.touched)
            self._sessions.pop(oldest.session_id, None)
        conv = self._sessions.get(session_id)
        if conv is None:
            conv = Conversation(session_id=session_id)
            self._sessions[session_id] = conv
        conv.touched = time.time()
        return conv

    def record(
        self,
        session_id: str,
        *,
        question: str,
        query_id: str,
        outcome: str,
        resolved_service_id: str | None = None,
        resolved_service_name: str | None = None,
        answers: dict[str, str] | None = None,
    ) -> None:
        """Append a turn and, when it settled on a service, make it the context.

        ``resolved_service_id`` is deliberately separate from ``service_id``:
        a refusal names a *suggested* institution and a disambiguation question
        names a *hint*, and neither has settled anything.
        """
        with self._lock:
            conv = self._get_or_create(session_id)
            conv.turns.append(
                Turn(
                    question=question,
                    query_id=query_id,
                    outcome=outcome,
                    service_id=resolved_service_id,
                    service_name=resolved_service_name,
                )
            )
            if len(conv.turns) > MAX_TURNS:
                conv.turns = conv.turns[-MAX_TURNS:]
            if resolved_service_id:
                conv.last_service_id = resolved_service_id
                conv.last_service_name = resolved_service_name
            if answers:
                conv.answers = {**conv.answers, **answers}
            conv.touched = time.time()

    def reset(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)


store = ConversationStore()