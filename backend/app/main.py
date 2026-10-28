"""Forrest AI demo backend: mock transcription, retrieval, answers, and speech."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import knowledge, mocks
from .models import (
    AnswerRequest,
    AnswerResponse,
    ApprovalStatus,
    ApproveRequest,
    RetrieveRequest,
    RetrieveResponse,
    RevokeRequest,
    SelectionRequest,
    SelectionState,
    SpeakRequest,
    SpeechState,
    StopRequest,
    TranscribeRequest,
    Transcript,
)

app = FastAPI(title="Forrest AI backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "forrest-ai-backend", "version": "0.1.0"}


@app.get("/api/sources")
def get_sources() -> dict[str, list[dict[str, object]]]:
    return {"sources": knowledge.list_sources()}


@app.post("/api/transcribe")
def post_transcribe(body: TranscribeRequest) -> Transcript:
    return mocks.transcribe(body.scenario)


def _require_current_selection(approved_ids: list[str]) -> None:
    """Reject source IDs outside the candidate's last synced selection."""
    outside = sorted(set(approved_ids) - mocks.current_selection())
    if outside:
        raise HTTPException(
            status_code=422,
            detail=f"Sources are outside the current selection: {', '.join(outside)}.",
        )


@app.post("/api/retrieve")
def post_retrieve(body: RetrieveRequest) -> RetrieveResponse:
    _require_current_selection(body.approved_source_ids)
    evidence, searched = knowledge.retrieve(body.question, body.approved_source_ids)
    return RetrieveResponse(evidence=evidence, searched_sources=searched)


@app.post("/api/answer")
def post_answer(body: AnswerRequest) -> AnswerResponse:
    _require_current_selection(body.approved_source_ids)
    try:
        evidence = knowledge.authoritative_evidence(
            body.question, body.evidence, body.approved_source_ids
        )
    except knowledge.EvidenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return mocks.generate_answer(body.question, evidence)


@app.post("/api/approve")
def post_approve(body: ApproveRequest) -> ApprovalStatus:
    status, error = mocks.approve(body.answer_id, body.approved_source_ids)
    if status == "unknown":
        raise HTTPException(status_code=404, detail=error)
    if status in ("refused", "mismatched"):
        raise HTTPException(status_code=422, detail=error)
    return ApprovalStatus(answer_id=body.answer_id, status="approved")


@app.post("/api/revoke")
def post_revoke(body: RevokeRequest) -> ApprovalStatus:
    status, error = mocks.revoke(body.answer_id)
    if status == "unknown":
        raise HTTPException(status_code=404, detail=error)
    return ApprovalStatus(answer_id=body.answer_id, status="unapproved", revoked=True)


@app.put("/api/selection")
def put_selection(body: SelectionRequest) -> SelectionState:
    epoch = mocks.set_selection(body.approved_source_ids)
    return SelectionState(approved_source_ids=sorted(body.approved_source_ids), epoch=epoch)


@app.get("/api/selection")
def get_selection() -> SelectionState:
    return SelectionState(
        approved_source_ids=sorted(mocks.current_selection()),
        epoch=mocks.selection_epoch(),
    )


@app.post("/api/speak")
def post_speak(body: SpeakRequest) -> SpeechState:
    status, error, activation_id = mocks.speak(body.answer_id)
    if status == "unknown":
        raise HTTPException(status_code=404, detail=error)
    if status == "refused":
        raise HTTPException(status_code=422, detail=error)
    if status == "forbidden":
        raise HTTPException(status_code=403, detail=error)
    return SpeechState(status="speaking", answer_id=body.answer_id, activation_id=activation_id)


def _current_speech() -> SpeechState:
    state = mocks.speech_state()
    status = state["status"]
    answer_id = state["answer_id"]
    activation_id = state["activation_id"]
    assert isinstance(status, str)
    assert answer_id is None or isinstance(answer_id, str)
    assert activation_id is None or isinstance(activation_id, str)
    return SpeechState(status=status, answer_id=answer_id, activation_id=activation_id)


@app.post("/api/stop")
def post_stop(body: StopRequest | None = None) -> SpeechState:
    activation_id = body.activation_id if body is not None else None
    mocks.stop(activation_id)
    return _current_speech()


@app.get("/api/speech")
def get_speech() -> SpeechState:
    return _current_speech()
