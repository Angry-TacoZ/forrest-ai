"""Eval runner: candidate output must never overwrite the committed baseline."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT = BACKEND_DIR.parent


def _load_runner():
    spec = importlib.util.spec_from_file_location("eval_run", ROOT / "evals" / "run.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["eval_run"] = module
    spec.loader.exec_module(module)
    return module


def test_default_output_is_candidate_not_baseline() -> None:
    run = _load_runner()
    args = run.parse_args([])
    assert Path(args.output).name == "interview-v1-candidate.json"
    assert args.update_baseline is False
    assert run.resolve_output(args).name == "interview-v1-candidate.json"


def test_update_baseline_flag_selects_baseline_path() -> None:
    run = _load_runner()
    args = run.parse_args(["--update-baseline"])
    assert run.resolve_output(args) == run.BASELINE_PATH


def test_run_leaves_committed_baseline_untouched(tmp_path: Path) -> None:
    baseline = ROOT / "evals" / "results" / "interview-v1.json"
    before = baseline.read_bytes()
    candidate = tmp_path / "candidate.json"
    completed = subprocess.run(
        [sys.executable, "evals/run.py", "--output", str(candidate)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert baseline.read_bytes() == before
    payload = json.loads(candidate.read_text(encoding="utf-8"))
    assert payload["summary"] == {"passed": 3, "failed": 0}
    assert payload["role"] == "candidate"
