# Forrest AI evaluations

Fixed, deterministic checks that the interview pipeline stays grounded in
approved evidence. No network calls, no randomness, no paid models.

## Layout

- `cases/` — fixed test cases (frozen inputs; never edit to chase scores).
- `results/` — committed baseline outputs for comparison.
- `run.py` — suite runner; exits non-zero on any failure.

`trajectories/` (model/tool execution traces) is not present yet: at the mock
stage the request/response pairs recorded in `results/` serve as the trace.
Live-provider trajectories will be added with the first real integration.

## Methodology

Each case runs the full mock pipeline — transcribe → retrieve → answer — and
asserts:

1. Answer status matches expectation (`grounded` or `blocked`).
2. Retrieved evidence count meets the case minimum.
3. Every grounded claim carries text plus at least one source id; blocked
   answers carry no claims and no answer text.

## Running

From the repository root, with the backend environment installed:

```text
backend\.venv\Scripts\python evals/run.py
```

The `eval` CI job runs the same command on every push and pull request.

## Baseline discipline

`results/interview-v1.json` is the committed baseline and is never overwritten
by a normal run: fresh output goes to the gitignored
`results/interview-v1-candidate.json`, which the runner compares against the
baseline (any drift fails the run). Refresh the baseline explicitly after
reviewing a candidate diff:

```text
backend\.venv\Scripts\python evals/run.py --update-baseline
```

A custom candidate path is available via `--output PATH`.
