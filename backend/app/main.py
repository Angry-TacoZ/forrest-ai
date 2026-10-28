"""Forrest AI demo backend: mock transcription, retrieval, answers, and speech."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import knowledge, mocks
from .models import (
    AnswerRequest,
    AnswerResponse,
    RetrieveRequest,
    RetrieveResponse,
    SpeakRequest,
    SpeechState,
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


@app.post("/api/retrieve")
def post_retrieve(body: RetrieveRequest) -> RetrieveResponse:
    evidence, searched = knowledge.retrieve(body.question, body.approved_source_ids)
    return RetrieveResponse(evidence=evidence, searched_sources=searched)


@app.post("/api/answer")
def post_answer(body: AnswerRequest) -> AnswerResponse:
    try:
        evidence = knowledge.authoritative_evidence(
            body.question, body.evidence, body.approved_source_ids
        )
    except knowledge.EvidenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return mocks.generate_answer(body.question, evidence)


@app.post("/api/speak")
def post_speak(body: SpeakRequest) -> SpeechState:
    status, error = mocks.speak(body.answer_id)
    if status == "unknown":
        raise HTTPException(status_code=404, detail=error)
    if status == "refused":
        raise HTTPException(status_code=422, detail=error)
    return SpeechState(status="speaking", answer_id=body.answer_id)


@app.post("/api/stop")
def post_stop() -> SpeechState:
    mocks.stop()
    return SpeechState(status="idle")


@app.get("/api/speech")
def get_speech() -> SpeechState:
    state = mocks.speech_state()
    status = state["status"]
    answer_id = state["answer_id"]
    assert isinstance(status, str)
    assert answer_id is None or isinstance(answer_id, str)
    return SpeechState(status=status, answer_id=answer_id)
