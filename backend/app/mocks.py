"""Deterministic mock AI services. No network calls, no randomness."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import TypedDict

from .models import AnswerResponse, Claim, Evidence, Transcript

ENGINE_TRANSCRIBE = "mock-transcribe-v1"
ENGINE_GENERATE = "mock-generate-v1"
VOICE_ID = "forrest-synthetic-v1"

APPROVAL_TTL_SECONDS = 15 * 60

QUESTIONS = {
    "supported": "Tell me about your backend experience with checkout latency.",
    "unsupported": "Are you able to perform pediatric neurosurgery?",
}

class _AnswerDetails(TypedDict):
    question: str
    evidence_sources: list[str]


class _Approval(TypedDict):
    epoch: int
    expires_at: datetime
    revoked: bool


_answer_registry: dict[str, str] = {}  # answer_id -> "grounded" | "blocked"
_answer_details: dict[str, _AnswerDetails] = {}
_approvals: dict[str, _Approval] = {}
_selection_epoch = 0
_speech: dict[str, str | None] = {"status": "idle", "answer_id": None, "activation_id": None}
_activation_seq = 0


def _utcnow() -> datetime:
    """Clock behind approval expiry; tests may monkeypatch this."""
    return datetime.now(UTC)


def set_selection(approved_ids: list[str]) -> int:
    """Record a new source selection; every change invalidates prior approvals."""
    global _selection_epoch
    _selection_epoch += 1
    return _selection_epoch


def transcribe(scenario: str) -> Transcript:
    """Return the canned interview question for a scenario."""
    return Transcript(question=QUESTIONS[scenario], scenario=scenario)


def _answer_id(question: str, evidence: list[Evidence]) -> str:
    fingerprint = question + "|" + "|".join(item.source_id for item in evidence)
    return "ans-" + hashlib.sha1(fingerprint.encode()).hexdigest()[:12]


def generate_answer(question: str, evidence: list[Evidence]) -> AnswerResponse:
    """Draft an answer grounded in evidence, or block it when unsupported."""
    answer_id = _answer_id(question, evidence)
    _answer_details[answer_id] = {
        "question": question,
        "evidence_sources": [item.source_id for item in evidence],
    }
    _approvals.pop(answer_id, None)  # Fresh verification starts unapproved.
    if not evidence:
        _answer_registry[answer_id] = "blocked"
        return AnswerResponse(
            status="blocked",
            reason=(
                "No approved evidence supports this question, "
                "so Forrest cannot answer it."
            ),
            answer_id=answer_id,
        )
    claims = [Claim(text=item.excerpt, source_ids=[item.source_id]) for item in evidence]
    joined = " ".join(f"[{i + 1}] {item.excerpt}" for i, item in enumerate(evidence))
    _answer_registry[answer_id] = "grounded"
    return AnswerResponse(
        status="grounded",
        answer=f"Based on your approved materials: {joined}",
        claims=claims,
        answer_id=answer_id,
    )


def approval_error(answer_id: str) -> str | None:
    """Return why an answer may not be spoken, or None when authorized."""
    if answer_id not in _answer_registry:
        return "unknown"
    if _answer_registry[answer_id] != "grounded":
        return "blocked"
    approval = _approvals.get(answer_id)
    if approval is None:
        return "not-approved"
    if approval["revoked"]:
        return "revoked"
    if approval["epoch"] != _selection_epoch:
        return "stale"
    if _utcnow() >= approval["expires_at"]:
        return "expired"
    return None


def approve(answer_id: str, approved_ids: list[str]) -> tuple[str, str | None]:
    """Approve a grounded answer under a selection covering its evidence."""
    if answer_id not in _answer_registry:
        return "unknown", f"Unknown answer id: {answer_id}."
    if _answer_registry[answer_id] != "grounded":
        return "refused", "Only grounded answers can be approved for speech."
    evidence_sources = set(_answer_details[answer_id]["evidence_sources"])
    if not evidence_sources.issubset(set(approved_ids)):
        return "mismatched", "Approval selection does not cover the answer's evidence."
    epoch = set_selection(approved_ids)
    _approvals[answer_id] = {
        "epoch": epoch,
        "expires_at": _utcnow() + timedelta(seconds=APPROVAL_TTL_SECONDS),
        "revoked": False,
    }
    return "approved", None


def revoke(answer_id: str) -> tuple[str, str | None]:
    """Revoke approval; the answer needs fresh approval before it may be spoken."""
    if answer_id not in _answer_registry:
        return "unknown", f"Unknown answer id: {answer_id}."
    approval = _approvals.get(answer_id)
    if approval is None:
        _approvals[answer_id] = {
            "epoch": _selection_epoch,
            "expires_at": _utcnow(),
            "revoked": True,
        }
    else:
        approval["revoked"] = True
    return "revoked", None


def speak(answer_id: str) -> tuple[str, str | None, str | None]:
    """Start mock speech. Returns (status, error, activation_id)."""
    reason = approval_error(answer_id)
    if reason == "unknown":
        return "unknown", f"Unknown answer id: {answer_id}.", None
    if reason == "blocked":
        return "refused", "Refusing to speak: this answer is blocked as unsupported.", None
    if reason is not None:
        messages = {
            "not-approved": "Answer has not been approved for speech.",
            "revoked": "Answer approval was revoked; approve it again to speak.",
            "stale": "Answer approval is stale; re-verify it under the current selection.",
            "expired": "Answer approval has expired; approve it again to speak.",
        }
        return "forbidden", messages[reason], None
    global _activation_seq
    _activation_seq += 1
    activation_id = f"spk-{_activation_seq:04d}"
    _speech["status"] = "speaking"
    _speech["answer_id"] = answer_id
    _speech["activation_id"] = activation_id
    return "speaking", None, activation_id


def stop(activation_id: str | None = None) -> bool:
    """Interrupt mock speech. With an id, only that activation is stopped.

    Returns True when the stop applied (or speech was already idle without
    a selector), False when it named a superseded activation.
    """
    if activation_id is not None and activation_id != _speech["activation_id"]:
        return False
    _speech["status"] = "idle"
    _speech["answer_id"] = None
    _speech["activation_id"] = None
    return True


def speech_state() -> dict[str, str | None]:
    """Return a copy of the current mock speech state."""
    return dict(_speech)
