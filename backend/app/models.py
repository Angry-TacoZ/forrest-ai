"""API request/response models."""

from pydantic import BaseModel, Field


class Source(BaseModel):
    id: str
    title: str
    kind: str
    summary: str
    approved_default: bool = True


class TranscribeRequest(BaseModel):
    scenario: str = Field(default="supported", pattern="^(supported|unsupported)$")


class Transcript(BaseModel):
    question: str
    scenario: str
    engine: str = "mock-transcribe-v1"
    duration_ms: int = 1800


class RetrieveRequest(BaseModel):
    question: str
    approved_source_ids: list[str] = Field(default_factory=list)


class Evidence(BaseModel):
    source_id: str
    source_title: str
    excerpt: str
    relevance: float


class RetrieveResponse(BaseModel):
    evidence: list[Evidence]
    searched_sources: int


class AnswerRequest(BaseModel):
    question: str
    evidence: list[Evidence] = Field(default_factory=list)


class Claim(BaseModel):
    text: str
    source_ids: list[str]


class AnswerResponse(BaseModel):
    status: str  # "grounded" | "blocked"
    answer: str = ""
    claims: list[Claim] = Field(default_factory=list)
    reason: str = ""
    answer_id: str


class SpeakRequest(BaseModel):
    answer_id: str


class SpeechState(BaseModel):
    status: str  # "idle" | "speaking"
    answer_id: str | None = None
    voice: str = "forrest-synthetic-v1"
