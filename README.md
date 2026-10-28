# Forrest AI

A consented, source-grounded interview assistant built for the **Meta Global AI Developer Hackathon**.

Forrest AI helps candidates communicate **verified personal experience** during job interviews — with explicit employer/interviewer consent, candidate review before every spoken answer, and no invented qualifications.

> **Status:** Repository bootstrap. Engineering rules are in place (`AGENTS.md`); application implementation has not started yet.

## Purpose

Job interviews reward fast recall of real experience. Forrest AI acts as a transparent aid:

1. The candidate imports and approves personal knowledge sources.
2. An authorized interview question is captured via speech transcription.
3. Retrieval finds relevant, candidate-approved evidence.
4. A source-grounded draft answer is generated.
5. Factual claims are verified before presentation.
6. The candidate reviews the answer and explicitly activates Forrest.
7. A distinct synthetic voice speaks through a selected audio device.
8. The candidate can interrupt or stop Forrest at any point.

What Forrest AI will never do: invent qualifications, hide the use of AI, speak without activation, or treat an unverified claim as fact.

## Technology stack (intended)

Provider interfaces keep every service interchangeable; no vendor is hard-wired into core logic.

| Role | Primary | Fallback |
|---|---|---|
| Answer generation | Meta Muse Spark | Deterministic mock service |
| Speech recognition | Meta Muse Voice Transcribe | Deterministic mock service |
| Text-to-speech | Baseten (hosted, if promotional credits are approved) | Kokoro TTS (local) |
| Embeddings | Modal (hosted, if promotional credits are approved) | Local embedding model |

No paid external infrastructure is activated without explicit authorization, and pending promotional credits are never assumed to be approved. Usage, latency, failures, and costs are tracked per provider.

## Accessibility goals

Accessibility is functional, not decorative:

- Full keyboard interaction with the review/activation flow.
- Readable, timely feedback for every system state (listening, retrieving, verifying, ready, speaking, failed).
- Clear indication of when Forrest is armed vs. silent.
- Immediate interruption available at all times.

## Meta hackathon participation

Built for the **Meta Global AI Developer Hackathon** by James Lane, using T3 Code with Meta Muse Code as the primary coding environment. AI features center on Meta's Muse Spark (generation) and Muse Voice Transcribe (speech recognition).

## Planned features

- Candidate knowledge import with per-source approve/exclude control.
- Authorized question capture with explicit interview disclosure.
- Retrieval constrained to candidate-approved sources.
- Source-grounded answer generation with preserved references.
- Claim verification that blocks unsupported statements.
- Candidate review screen with explicit activation.
- Clearly synthetic, distinguishable TTS voice on a selectable device.
- Instant interruption and fail-safe behavior when any stage fails.
- Fixed evaluation sets covering grounding, retrieval relevance, leakage of excluded information, transcription accuracy, latency, interruption, error recovery, and cost.

## Privacy and security

This is a **public** repository. It must never contain real candidate data:

- No API keys, tokens, credentials, or `.env` files.
- No private candidate documents, transcripts, recordings, or personal health information.
- Public demonstrations use fictional or sanitized data only.
- Real candidate records and credentials stay outside the repository (see `.gitignore`).

Interview recordings and transcripts are not retained by default, and imported content is treated as untrusted input with prompt-injection defenses at the retrieval/generation boundary.

## Repository layout

- `AGENTS.md` — engineering rules: GitHub workflow, verification gates, evaluation, security, acceptance criteria.
- `README.md` — this file.
- `.gitignore` — Python, Node.js, credentials, local databases, candidate records, recordings, and build artifacts.
- `evals/` *(planned)* — fixed test cases, baseline/candidate results, execution traces, methodology.

## Engineering workflow

All development follows `AGENTS.md`: inspect first, work on feature branches, verify with tests/builds/runtime checks, evaluate AI behavior changes against fixed baselines, and open pull requests for review. Direct pushes to `main` and merges without the owner's explicit approval are not allowed.

**Inspect first. Verify outcomes. Preserve evidence. Keep the human in control.**
