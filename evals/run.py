"""Deterministic evaluation smoke test for the mock interview pipeline.

Runs the fixed cases in evals/cases/ against the backend app through the
FastAPI TestClient (no network, no randomness). Fresh output goes to the
gitignored candidate file and is compared against the committed baseline;
any case failure or baseline drift exits non-zero. Refresh the baseline
explicitly with --update-baseline after reviewing a candidate diff.

Usage (from the repository root):
    backend\\.venv\\Scripts\\python evals/run.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient

from app.main import app

CASES_PATH = ROOT / "evals" / "cases" / "interview-v1.json"
BASELINE_PATH = ROOT / "evals" / "results" / "interview-v1.json"
CANDIDATE_PATH = ROOT / "evals" / "results" / "interview-v1-candidate.json"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse runner arguments (argv injectable for tests)."""
    parser = argparse.ArgumentParser(description="Run the interview-v1 eval suite.")
    parser.add_argument(
        "--output",
        default=str(CANDIDATE_PATH),
        help="Where to write results (default: the gitignored candidate file).",
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Overwrite the committed baseline instead of the candidate file.",
    )
    return parser.parse_args(argv)


def resolve_output(args: argparse.Namespace) -> Path:
    """Return the results path for parsed arguments."""
    if args.update_baseline:
        return BASELINE_PATH
    return Path(args.output)


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


def _comparable(payload: dict) -> dict:
    compared = dict(payload)
    compared.pop("role", None)
    return compared


def main(output: Path) -> int:
    """Run all cases, write results, compare with baseline when applicable."""
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    client = TestClient(app)
    results = [run_case(client, case) for case in cases]
    passed = sum(1 for result in results if result["pass"])
    is_baseline = output.resolve() == BASELINE_PATH.resolve()
    payload = {
        "suite": "interview-v1",
        "role": "baseline" if is_baseline else "candidate",
        "engines": {"transcribe": "mock-transcribe-v1", "generate": "mock-generate-v1"},
        "cases": results,
        "summary": {"passed": passed, "failed": len(results) - passed},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    for result in results:
        mark = "PASS" if result["pass"] else "FAIL"
        print(f"{mark} {result['id']}: {result['actual_status']} "
              f"(evidence={result['evidence_count']})")
    try:
        display = str(output.relative_to(ROOT))
    except ValueError:
        display = str(output)
    print(f"{passed}/{len(results)} cases passed -> {display}")
    if passed != len(results):
        return 1
    if is_baseline or not BASELINE_PATH.exists():
        return 0
    baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    if _comparable(baseline) != _comparable(payload):
        print("BASELINE DRIFT: candidate differs from evals/results/interview-v1.json.")
        print("Review the diff, then refresh explicitly with --update-baseline.")
        return 1
    print("Candidate matches the committed baseline.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(resolve_output(parse_args())))
