"""Backend API tests: pipeline, approvals, blocking, and speech gating."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

SUPPORTED = "Tell me about your backend experience with checkout systems."
UNSUPPORTED = "Are you able to perform pediatric neurosurgery?"
ALL_SOURCES = ["resume-summary", "project-latency", "cert-aws"]


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_sources_are_fictional_and_approved_by_default() -> None:
    response = client.get("/api/sources")
    assert response.status_code == 200
    sources = response.json()["sources"]
    assert [source["id"] for source in sources] == ALL_SOURCES
    assert all("fictional" in source["title"].lower() for source in sources)
    assert all(source["approved_default"] for source in sources)


def test_transcribe_scenarios_are_deterministic() -> None:
    for scenario, expected in [("supported", SUPPORTED), ("unsupported", UNSUPPORTED)]:
        first = client.post("/api/transcribe", json={"scenario": scenario}).json()
        second = client.post("/api/transcribe", json={"scenario": scenario}).json()
        assert first == second
        assert first["question"] == expected
        assert first["engine"] == "mock-transcribe-v1"


def test_transcribe_rejects_unknown_scenario() -> None:
    response = client.post("/api/transcribe", json={"scenario": "live"})
    assert response.status_code == 422


def test_retrieve_finds_approved_evidence() -> None:
    response = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["searched_sources"] == 3
    assert len(body["evidence"]) >= 2
    assert body["evidence"][0]["source_id"] == "resume-summary"
    assert all(item["relevance"] > 0 for item in body["evidence"])


def test_retrieve_respects_excluded_sources() -> None:
    response = client.post(
        "/api/retrieve",
        json={"question": SUPPORTED, "approved_source_ids": ["project-latency"]},
    )
    body = response.json()
    assert body["searched_sources"] == 1
    assert [item["source_id"] for item in body["evidence"]] == ["project-latency"]


def test_retrieve_returns_empty_when_nothing_matches() -> None:
    response = client.post(
        "/api/retrieve",
        json={"question": UNSUPPORTED, "approved_source_ids": ALL_SOURCES},
    )
    assert response.json()["evidence"] == []


def test_answer_is_grounded_with_sourced_claims() -> None:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    response = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "grounded"
    assert body["answer"].startswith("Based on your approved materials:")
    assert len(body["claims"]) == len(evidence)
    for claim in body["claims"]:
        assert claim["source_ids"]
        assert claim["text"]


def test_answer_is_blocked_without_evidence() -> None:
    response = client.post("/api/answer", json={"question": UNSUPPORTED, "evidence": []})
    body = response.json()
    assert body["status"] == "blocked"
    assert body["answer"] == ""
    assert "cannot answer" in body["reason"]


def test_speak_rejects_unknown_and_blocked_answers() -> None:
    unknown = client.post("/api/speak", json={"answer_id": "ans-doesnotexist"})
    assert unknown.status_code == 404
    blocked = client.post(
        "/api/answer", json={"question": UNSUPPORTED, "evidence": []}
    ).json()
    refused = client.post("/api/speak", json={"answer_id": blocked["answer_id"]})
    assert refused.status_code == 422


def test_speak_and_stop_flow() -> None:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    grounded = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ALL_SOURCES,
        },
    ).json()
    speaking = client.post("/api/speak", json={"answer_id": grounded["answer_id"]})
    assert speaking.json()["status"] == "speaking"
    assert speaking.json()["voice"] == "forrest-synthetic-v1"
    assert client.get("/api/speech").json()["status"] == "speaking"
    stopped = client.post("/api/stop")
    assert stopped.json()["status"] == "idle"
    assert client.get("/api/speech").json()["answer_id"] is None


def test_answer_rejects_fabricated_excerpt() -> None:
    response = client.post(
        "/api/answer",
        json={
            "question": UNSUPPORTED,
            "evidence": [
                {
                    "source_id": "resume-summary",
                    "source_title": "Resume summary (fictional)",
                    "excerpt": (
                        "Alex Rivera completed a neurosurgery residency at "
                        "Harvard Medical School and holds a board "
                        "certification in pediatric neurosurgery."
                    ),
                    "relevance": 1.0,
                }
            ],
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.status_code == 422
    assert "does not match server records" in response.json()["detail"]


def test_answer_rejects_unknown_source() -> None:
    response = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": [
                {
                    "source_id": "harvard-transcript",
                    "source_title": "Harvard transcript (fabricated)",
                    "excerpt": "Graduated summa cum laude in neurosurgery.",
                    "relevance": 1.0,
                }
            ],
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.status_code == 422
    assert "Unknown evidence source" in response.json()["detail"]


def test_answer_rejects_excluded_source() -> None:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    response = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ["project-latency"],
        },
    )
    assert response.status_code == 422
    assert "not approved" in response.json()["detail"]


def test_answer_rejects_valid_evidence_for_wrong_question() -> None:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    response = client.post(
        "/api/answer",
        json={
            "question": UNSUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.status_code == 422
    assert "does not match server retrieval" in response.json()["detail"]


def test_answer_rejects_empty_evidence_for_supported_question() -> None:
    response = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": [],
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.status_code == 422
    assert "does not match server retrieval" in response.json()["detail"]


def test_rejected_evidence_is_never_registered_as_speakable() -> None:
    fabricated = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": [
                {
                    "source_id": "cert-aws",
                    "source_title": "Certification (fictional)",
                    "excerpt": "Alex holds ten cloud fellowships and a private pilot license.",
                    "relevance": 1.0,
                }
            ],
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert fabricated.status_code == 422
    assert "answer_id" not in fabricated.json()
    unknown = client.post("/api/speak", json={"answer_id": "ans-forged0001"})
    assert unknown.status_code == 404
