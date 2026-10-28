# Demo guide — PR #1 application foundation

Runs the mock interview workspace end to end. No paid APIs, no real data.

## Prerequisites

- Node 24 (`node --version`)
- Python 3.14 (`py -3.14 --version`)
- This branch checked out: `feat/application-foundation`

## Start the backend

From the repository root:

```powershell
cd backend
py -3.14 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
python -m uvicorn app.main:app --port 8000
```

Health check: http://localhost:8000/api/health

## Start the frontend

In a second terminal, from the repository root:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in a browser.

## Demo path A — supported question

1. Leave all three library sources approved.
2. Select **Supported question**, then **Capture question**.
3. Select **Draft answer**: evidence with source titles appears, then a draft answer.
4. Check **I reviewed this answer and approve it**.
5. Select **Activate Forrest**: state becomes Speaking.
6. Select **Interrupt**: speech stops, state returns to Ready for review.

## Demo path B — unsupported question

1. Select **Unsupported question**, then **Capture question**.
2. Select **Draft answer**: the answer panel shows **Answer blocked** with a reason.
3. **Activate Forrest** stays disabled — blocked answers cannot be spoken.

## Session safety

- Reset during speaking stops backend speech first; if the stop fails, the
  error is shown and Interrupt stays available for a retry.
- Changing source approvals clears the draft, evidence, and candidate
  approval; in-flight requests from the older selection are discarded.
- The backend re-validates evidence against server records: unknown, modified,
  excluded, or mismatched evidence is rejected and can never be spoken.

## Checks

```powershell
# Backend (from backend/, venv active)
python -m pytest -q; ruff check app tests; mypy app

# Frontend (from frontend/)
npm run lint; npm run typecheck; npm run test; npm run build

# Evaluation fixture (from the repository root)
backend\.venv\Scripts\python evals/run.py
```

Stop the servers with Ctrl+C in each terminal.
