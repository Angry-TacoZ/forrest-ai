"""Fictional candidate knowledge base for the PR #1 demo.

Every record here is invented. Real candidate data must never be committed.
"""

from __future__ import annotations

from .models import Evidence

SOURCES: list[dict[str, object]] = [
    {
        "id": "resume-summary",
        "title": "Resume summary (fictional)",
        "kind": "resume",
        "summary": "4 years of Python backend work, FastAPI checkout API.",
        "approved_default": True,
    },
    {
        "id": "project-latency",
        "title": "Project story: checkout latency (fictional)",
        "kind": "project",
        "summary": "Cut checkout p95 latency 420ms to 250ms at fictional Acme Widgets.",
        "approved_default": True,
    },
    {
        "id": "cert-aws",
        "title": "Certification (fictional)",
        "kind": "certification",
        "summary": "Fictional AWS Solutions Architect Associate, 2024.",
        "approved_default": True,
    },
]

_CHUNKS: list[tuple[str, str]] = [
    (
        "resume-summary",
        (
            "Alex Rivera has four years of Python backend experience building FastAPI "
            "services, including a checkout API serving two million requests per day "
            "on PostgreSQL."
        ),
    ),
    (
        "project-latency",
        (
            "At the fictional Acme Widgets, Alex cut checkout p95 latency from 420ms "
            "to 250ms with query batching and a Redis cache."
        ),
    ),
    (
        "cert-aws",
        (
            "Alex holds a fictional AWS Solutions Architect Associate "
            "certification from 2024."
        ),
    ),
]

_STOPWORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "about",
        "me", "you", "your", "yours", "what", "how", "why", "when", "do",
        "does", "is", "are", "was", "were", "tell", "describe", "give", "can",
    }
)

# Minimum shared content tokens for a mock retrieval hit. A single shared
# word is not grounding (production retrieval must be semantic).
_MIN_OVERLAP = 2


def list_sources() -> list[dict[str, object]]:
    """Return all knowledge sources (candidate toggles approval in the UI)."""
    return [dict(source) for source in SOURCES]


def _tokens(text: str) -> set[str]:
    words = {word.strip(".,!?;:()\"'").lower() for word in text.split()}
    return {word for word in words if len(word) > 2 and word not in _STOPWORDS}


def retrieve(
    question: str, approved_ids: list[str], limit: int = 3
) -> tuple[list[Evidence], int]:
    """Deterministic keyword retrieval over approved sources only.

    Returns (evidence, searched_sources). Excluded sources are never searched.
    """
    approved = {source["id"] for source in SOURCES if source["id"] in set(approved_ids)}
    question_tokens = _tokens(question)
    scored: list[tuple[int, int, str, str]] = []
    for index, (source_id, text) in enumerate(_CHUNKS):
        if source_id not in approved:
            continue
        overlap = len(question_tokens & _tokens(text))
        if overlap >= _MIN_OVERLAP:
            scored.append((overlap, index, source_id, text))
    scored.sort(key=lambda item: (-item[0], item[1]))
    titles = {str(source["id"]): str(source["title"]) for source in SOURCES}
    evidence = [
        Evidence(
            source_id=source_id,
            source_title=titles[source_id],
            excerpt=text,
            relevance=round(overlap / max(len(question_tokens), 1), 2),
        )
        for overlap, _, source_id, text in scored[:limit]
    ]
    return evidence, len(approved)


class EvidenceError(ValueError):
    """Raised when client-submitted evidence fails server-side validation."""


def authoritative_evidence(
    question: str, submitted: list[Evidence], approved_ids: list[str]
) -> list[Evidence]:
    """Validate submitted evidence and return the server's own retrieval.

    Client excerpts are never trusted: every item must name a known source,
    carry an excerpt byte-identical to a server record, and come from an
    approved source. The submitted set must also exactly match what the
    server retrieves for this question, so valid excerpts cannot be
    smuggled into unrelated questions. Generation must use only the
    returned evidence.
    """
    known_sources = {str(source["id"]) for source in SOURCES}
    approved = {source_id for source_id in approved_ids if source_id in known_sources}
    records = {(source_id, text) for source_id, text in _CHUNKS}
    for item in submitted:
        if item.source_id not in known_sources:
            raise EvidenceError(f"Unknown evidence source: {item.source_id}.")
        if (item.source_id, item.excerpt) not in records:
            raise EvidenceError("Evidence excerpt does not match server records.")
        if item.source_id not in approved:
            raise EvidenceError(f"Evidence source is not approved: {item.source_id}.")
    server_evidence, _ = retrieve(question, approved_ids)
    server_keys = {(item.source_id, item.excerpt) for item in server_evidence}
    submitted_keys = {(item.source_id, item.excerpt) for item in submitted}
    if submitted_keys != server_keys:
        raise EvidenceError(
            "Submitted evidence does not match server retrieval for this question."
        )
    return server_evidence
