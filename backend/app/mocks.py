"""Deterministic mock AI services. No network calls, no randomness."""

from __future__ import annotations

import hashlib

from .models import AnswerResponse, Claim, Evidence, Transcript

ENGINE_TRANSCRIBE = "mock-transcribe-v1"
ENGINE_GENERATE = "mock-generate-v1"
VOICE_ID = "forrest-synthetic-v1"

QUESTIONS = {
    "supported": "Tell me about your backend experience with checkout systems.",
    "unsupported": "Are you able to perform pediatric neurosurgery?",
}

_answer_registry: dict[str, str] = {}  # answer_id -> "grounded" | "blocked"
_speech: dict[str, str | None] = {"status": "idle", "answer_id": None}


def transcribe(scenario: str) -> Transcript:
    """Return the canned interview question for a scenario."""
    return Transcript(question=QUESTIONS[scenario], scenario=scenario)


def _answer_id(question: str, evidence: list[Evidence]) -> str:
    fingerprint = question + "|" + "|".join(item.source_id for item in evidence)
    return "ans-" + hashlib.sha1(fingerprint.encode()).hexdigest()[:12]


def generate_answer(question: str, evidence: list[Evidence]) -> AnswerResponse:
    """Draft an answer grounded in evidence, or block it when unsupported."""
    answer_id = _answer_id(question, evidence)
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


def speak(answer_id: str) -> tuple[str, str | None]:
    """Start mock speech. Returns (status, error); blocked answers are refused."""
    status = _answer_registry.get(answer_id)
    if status is None:
        return "unknown", f"Unknown answer id: {answer_id}."
    if status != "grounded":
        return "refused", "Refusing to speak: this answer is blocked as unsupported."
    _speech["status"] = "speaking"
    _speech["answer_id"] = answer_id
    return "speaking", None


def stop() -> None:
    """Interrupt mock speech immediately."""
    _speech["status"] = "idle"
    _speech["answer_id"] = None


def speech_state() -> dict[str, str | None]:
    """Return a copy of the current mock speech state."""
    return dict(_speech)
