"""Backend API tests: pipeline, approvals, blocking, and speech gating."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app import mocks
from app.main import app

client = TestClient(app)

SUPPORTED = "Tell me about your backend experience with checkout latency."
UNSUPPORTED = "Are you able to perform pediatric neurosurgery?"
ALL_SOURCES = ["resume-summary", "project-latency", "cert-aws"]


@pytest.fixture(autouse=True)
def _restore_full_selection() -> Iterator[None]:
    """The mock server holds one global selection; hand each test a full one."""
    yield
    client.put("/api/selection", json={"approved_source_ids": ALL_SOURCES})


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


def test_retrieve_rejects_sources_outside_synced_selection() -> None:
    narrowed = client.put(
        "/api/selection", json={"approved_source_ids": ["project-latency"]}
    )
    assert narrowed.status_code == 200
    rejected = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    )
    assert rejected.status_code == 422
    assert "current selection" in rejected.json()["detail"]
    allowed = client.post(
        "/api/retrieve",
        json={"question": SUPPORTED, "approved_source_ids": ["project-latency"]},
    )
    assert allowed.status_code == 200
    assert [item["source_id"] for item in allowed.json()["evidence"]] == ["project-latency"]


def test_answer_rejects_sources_outside_synced_selection() -> None:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    narrowed = client.put(
        "/api/selection", json={"approved_source_ids": ["project-latency"]}
    )
    assert narrowed.status_code == 200
    rejected = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert rejected.status_code == 422
    assert "current selection" in rejected.json()["detail"]


def test_selection_round_trip() -> None:
    put = client.put("/api/selection", json={"approved_source_ids": ["project-latency"]})
    assert put.status_code == 200
    got = client.get("/api/selection").json()
    assert got["approved_source_ids"] == ["project-latency"]
    assert got["epoch"] == put.json()["epoch"]


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
    approved = _approve(grounded["answer_id"])
    assert approved.json()["status"] == "approved"
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


def _grounded_answer_id() -> str:
    evidence = client.post(
        "/api/retrieve", json={"question": SUPPORTED, "approved_source_ids": ALL_SOURCES}
    ).json()["evidence"]
    return client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": evidence,
            "approved_source_ids": ALL_SOURCES,
        },
    ).json()["answer_id"]


def _approve(
    answer_id: str, approved_ids: list[str] | None = None
) -> httpx.Response:
    """Approve against the server's current generation (rejects on reorder)."""
    ids = ALL_SOURCES if approved_ids is None else approved_ids
    epoch = client.get("/api/selection").json()["epoch"]
    return client.post(
        "/api/approve",
        json={"answer_id": answer_id, "approved_source_ids": ids, "epoch": epoch},
    )


def _approved_answer_id() -> str:
    answer_id = _grounded_answer_id()
    response = _approve(answer_id)
    assert response.status_code == 200
    return answer_id


def test_speak_issues_unique_activation_ids() -> None:
    answer_id = _approved_answer_id()
    first = client.post("/api/speak", json={"answer_id": answer_id}).json()
    second = client.post("/api/speak", json={"answer_id": answer_id}).json()
    assert first["activation_id"] != second["activation_id"]
    assert first["activation_id"].startswith("spk-")
    client.post("/api/stop", json={})


def test_stop_with_superseded_activation_id_is_ignored() -> None:
    answer_id = _approved_answer_id()
    first = client.post("/api/speak", json={"answer_id": answer_id}).json()
    second = client.post("/api/speak", json={"answer_id": answer_id}).json()
    ignored = client.post("/api/stop", json={"activation_id": first["activation_id"]}).json()
    assert ignored["status"] == "speaking"
    assert ignored["activation_id"] == second["activation_id"]
    client.post("/api/stop", json={})


def test_stop_with_current_activation_id_stops() -> None:
    answer_id = _approved_answer_id()
    current = client.post("/api/speak", json={"answer_id": answer_id}).json()
    stopped = client.post("/api/stop", json={"activation_id": current["activation_id"]}).json()
    assert stopped["status"] == "idle"
    assert stopped["activation_id"] is None


def test_stop_without_id_always_stops() -> None:
    answer_id = _approved_answer_id()
    client.post("/api/speak", json={"answer_id": answer_id})
    assert client.post("/api/stop", json={}).json()["status"] == "idle"
    assert client.post("/api/stop", json={}).json()["status"] == "idle"


def test_single_keyword_overlap_is_not_grounding() -> None:
    response = client.post(
        "/api/retrieve",
        json={
            "question": "Can you perform neurosurgery using Python?",
            "approved_source_ids": ALL_SOURCES,
        },
    )
    assert response.json()["evidence"] == []


def test_keyword_bypass_question_is_blocked_end_to_end() -> None:
    question = "Can you perform neurosurgery using Python?"
    retrieved = client.post(
        "/api/retrieve",
        json={"question": question, "approved_source_ids": ALL_SOURCES},
    ).json()["evidence"]
    blocked = client.post(
        "/api/answer",
        json={
            "question": question,
            "evidence": retrieved,
            "approved_source_ids": ALL_SOURCES,
        },
    ).json()
    assert blocked["status"] == "blocked"
    assert blocked["answer"] == ""


def test_speak_rejects_unapproved_grounded_answer() -> None:
    answer_id = _grounded_answer_id()
    response = client.post("/api/speak", json={"answer_id": answer_id})
    assert response.status_code == 403
    assert "not been approved" in response.json()["detail"]


def test_approve_rejects_unknown_answer() -> None:
    response = _approve("ans-forged0002")
    assert response.status_code == 404


def test_approve_rejects_blocked_answer() -> None:
    blocked = client.post(
        "/api/answer", json={"question": UNSUPPORTED, "evidence": []}
    ).json()
    response = _approve(blocked["answer_id"])
    assert response.status_code == 422


def test_approve_rejects_selection_missing_evidence_source() -> None:
    answer_id = _grounded_answer_id()
    response = _approve(answer_id, ["project-latency"])
    assert response.status_code == 422
    assert "does not cover" in response.json()["detail"]
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_revoked_answer_cannot_speak_until_reapproved() -> None:
    answer_id = _approved_answer_id()
    revoked = client.post("/api/revoke", json={"answer_id": answer_id})
    assert revoked.json()["status"] == "unapproved"
    assert revoked.json()["revoked"] is True
    forbidden = client.post("/api/speak", json={"answer_id": answer_id})
    assert forbidden.status_code == 403
    assert "revoked" in forbidden.json()["detail"]
    assert _approved_answer_id() == answer_id
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 200
    client.post("/api/stop", json={})


def test_approve_rejects_evidence_excluded_from_current_selection() -> None:
    answer_id = _grounded_answer_id()
    narrowed = client.put(
        "/api/selection", json={"approved_source_ids": ["project-latency"]}
    )
    assert narrowed.status_code == 200
    stale_approve = _approve(answer_id)
    assert stale_approve.status_code == 422
    assert "no longer within" in stale_approve.json()["detail"]
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_selection_change_stales_existing_approval() -> None:
    answer_id = _approved_answer_id()
    selection = client.put(
        "/api/selection", json={"approved_source_ids": ["project-latency"]}
    )
    assert selection.status_code == 200
    assert selection.json()["epoch"] >= 1
    stale = client.post("/api/speak", json={"answer_id": answer_id})
    assert stale.status_code == 403
    assert "stale" in stale.json()["detail"]


def test_regenerated_answer_requires_fresh_approval() -> None:
    answer_id = _approved_answer_id()
    assert _grounded_answer_id() == answer_id
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_expired_approval_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    answer_id = _grounded_answer_id()
    now = datetime.now(UTC)
    monkeypatch.setattr(mocks, "_utcnow", lambda: now)
    approved = _approve(answer_id)
    assert approved.status_code == 200
    monkeypatch.setattr(mocks, "_utcnow", lambda: now + timedelta(seconds=16 * 60))
    expired = client.post("/api/speak", json={"answer_id": answer_id})
    assert expired.status_code == 403
    assert "expired" in expired.json()["detail"]


def test_revoke_unknown_answer_is_not_found() -> None:
    response = client.post("/api/revoke", json={"answer_id": "ans-forged0003"})
    assert response.status_code == 404


def test_revoke_is_idempotent() -> None:
    answer_id = _approved_answer_id()
    assert client.post("/api/revoke", json={"answer_id": answer_id}).status_code == 200
    assert client.post("/api/revoke", json={"answer_id": answer_id}).status_code == 200
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_stale_approval_request_cannot_reverse_revocation() -> None:
    answer_id = _grounded_answer_id()
    issued_epoch = client.get("/api/selection").json()["epoch"]
    # The candidate's reset reaches the server first (revocation).
    assert client.post("/api/revoke", json={"answer_id": answer_id}).status_code == 200
    # The delayed approve issued before the reset arrives afterward.
    late = client.post(
        "/api/approve",
        json={
            "answer_id": answer_id,
            "approved_source_ids": ALL_SOURCES,
            "epoch": issued_epoch,
        },
    )
    assert late.status_code == 409
    assert "does not match" in late.json()["detail"]
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_approve_requires_a_selection_generation() -> None:
    answer_id = _grounded_answer_id()
    missing = client.post(
        "/api/approve",
        json={"answer_id": answer_id, "approved_source_ids": ALL_SOURCES},
    )
    assert missing.status_code == 422


def test_approve_accepts_current_generation() -> None:
    answer_id = _grounded_answer_id()
    epoch = client.get("/api/selection").json()["epoch"]
    response = client.post(
        "/api/approve",
        json={
            "answer_id": answer_id,
            "approved_source_ids": ALL_SOURCES,
            "epoch": epoch,
        },
    )
    assert response.status_code == 200
    assert response.json()["epoch"] == epoch


def test_approve_rejects_future_generation() -> None:
    answer_id = _grounded_answer_id()
    epoch = client.get("/api/selection").json()["epoch"]
    future = client.post(
        "/api/approve",
        json={
            "answer_id": answer_id,
            "approved_source_ids": ALL_SOURCES,
            "epoch": epoch + 5,
        },
    )
    assert future.status_code == 409
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_approval_delayed_beyond_selection_change_is_rejected() -> None:
    answer_id = _grounded_answer_id()
    issued = client.get("/api/selection").json()["epoch"]
    bumped = client.put("/api/selection", json={"approved_source_ids": ALL_SOURCES})
    assert bumped.status_code == 200
    late = client.post(
        "/api/approve",
        json={
            "answer_id": answer_id,
            "approved_source_ids": ALL_SOURCES,
            "epoch": issued,
        },
    )
    assert late.status_code == 409
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 403


def test_client_can_resynchronize_after_generation_reset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answer_id = _approved_answer_id()
    bumped = client.put("/api/selection", json={"approved_source_ids": ALL_SOURCES})
    assert bumped.json()["epoch"] >= 1
    # Simulate a backend restart: registries and the generation are wiped.
    monkeypatch.setattr(mocks, "_selection_epoch", 0)
    monkeypatch.setattr(mocks, "_current_selection", set(ALL_SOURCES))
    monkeypatch.setattr(mocks, "_answer_registry", {})
    monkeypatch.setattr(mocks, "_answer_details", {})
    monkeypatch.setattr(mocks, "_approvals", {})
    monkeypatch.setattr(
        mocks, "_speech", {"status": "idle", "answer_id": None, "activation_id": None}
    )
    resynced = client.get("/api/selection").json()
    assert resynced["epoch"] == 0
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 404
    fresh = _grounded_answer_id()
    assert _approve(fresh).status_code == 200


def test_revoke_stops_active_speech_for_that_answer() -> None:
    answer_id = _approved_answer_id()
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 200
    assert client.get("/api/speech").json()["status"] == "speaking"
    assert client.post("/api/revoke", json={"answer_id": answer_id}).status_code == 200
    state = client.get("/api/speech").json()
    assert state["status"] == "idle"
    assert state["answer_id"] is None
    assert state["activation_id"] is None


def test_selection_change_stops_active_speech() -> None:
    answer_id = _approved_answer_id()
    assert client.post("/api/speak", json={"answer_id": answer_id}).status_code == 200
    narrowed = client.put(
        "/api/selection", json={"approved_source_ids": ["project-latency"]}
    )
    assert narrowed.status_code == 200
    assert client.get("/api/speech").json()["status"] == "idle"


def test_revoke_leaves_unrelated_speech_running() -> None:
    first = _approved_answer_id()
    subset_evidence = client.post(
        "/api/retrieve",
        json={"question": SUPPORTED, "approved_source_ids": ["project-latency"]},
    ).json()["evidence"]
    second = client.post(
        "/api/answer",
        json={
            "question": SUPPORTED,
            "evidence": subset_evidence,
            "approved_source_ids": ["project-latency"],
        },
    ).json()["answer_id"]
    assert second != first
    assert _approve(second, ["project-latency"]).status_code == 200
    assert client.post("/api/speak", json={"answer_id": first}).status_code == 200
    assert client.post("/api/revoke", json={"answer_id": second}).status_code == 200
    state = client.get("/api/speech").json()
    assert state["status"] == "speaking"
    assert state["answer_id"] == first
    client.post("/api/stop", json={})
