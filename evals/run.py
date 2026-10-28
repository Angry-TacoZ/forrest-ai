"""Deterministic evaluation smoke test for the mock interview pipeline.

Runs the fixed cases in evals/cases/ against the backend app through the
FastAPI TestClient (no network, no randomness) and writes machine-readable
results to evals/results/. Exits non-zero if any case fails.

Usage (from the repository root):
    backend\\.venv\\Scripts\\python evals/run.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient

from app.main import app

CASES_PATH = ROOT / "evals" / "cases" / "interview-v1.json"
RESULTS_PATH = ROOT / "evals" / "results" / "interview-v1.json"


def run_case(client: TestClient, case: dict) -> dict:
    """Run transcribe -> retrieve -> answer for one case and score it."""
    transcript = client.post("/api/transcribe", json={"scenario": case["scenario"]}).json()
    retrieved = client.post(
        "/api/retrieve",
        json={
            "question": transcript["question"],
            "approved_source_ids": case["approved_source_ids"],
        },
    ).json()
    answer = client.post(
        "/api/answer",
        json={
            "question": transcript["question"],
            "evidence": retrieved["evidence"],
            "approved_source_ids": case["approved_source_ids"],
        },
    ).json()
    expected = case["expect"]
    if expected["status"] == "grounded":
        claims_ok = len(answer["claims"]) > 0 and all(
            claim["text"] and claim["source_ids"] for claim in answer["claims"]
        )
    else:
        claims_ok = answer["claims"] == [] and answer["answer"] == ""
    passed = (
        answer["status"] == expected["status"]
        and len(retrieved["evidence"]) >= expected["min_evidence"]
        and claims_ok
    )
    return {
        "id": case["id"],
        "question": transcript["question"],
        "expected_status": expected["status"],
        "actual_status": answer["status"],
        "evidence_count": len(retrieved["evidence"]),
        "evidence_sources": [item["source_id"] for item in retrieved["evidence"]],
        "claims_ok": claims_ok,
        "pass": passed,
    }


def main() -> int:
    """Run all cases, write results, and return the process exit code."""
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    client = TestClient(app)
    results = [run_case(client, case) for case in cases]
    passed = sum(1 for result in results if result["pass"])
    payload = {
        "suite": "interview-v1",
        "engines": {"transcribe": "mock-transcribe-v1", "generate": "mock-generate-v1"},
        "cases": results,
        "summary": {"passed": passed, "failed": len(results) - passed},
    }
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULTS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    for result in results:
        mark = "PASS" if result["pass"] else "FAIL"
        print(f"{mark} {result['id']}: {result['actual_status']} "
              f"(evidence={result['evidence_count']})")
    print(f"{passed}/{len(results)} cases passed -> {RESULTS_PATH.relative_to(ROOT)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
