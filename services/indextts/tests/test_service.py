import hashlib
import io
import uuid
import wave
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from core import MODEL, normalize, synthesize, validate_payload
from api import create_app
import ledger

OWNER = "a" * 32


def wav(seconds=12):
    result = io.BytesIO()
    with wave.open(result, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(22050)
        stream.writeframes(b"\0\0" * (22050 * seconds))
    return result.getvalue()


def payload(raw):
    return {"text": "Synthetic test", "model": MODEL, "speed": 1.5, "language": "zh", "reference_hash": hashlib.sha256(raw).hexdigest()}


@pytest.fixture(autouse=True)
def clean():
    with ledger.connection() as conn:
        conn.execute("DELETE FROM indextts_requests")


def register():
    request = str(uuid.uuid4())
    with ledger.connection() as conn:
        conn.execute("INSERT INTO indextts_requests(owner,id,payload) VALUES(%s,%s,'{}')", (OWNER, request))
    return request


def test_normalization_and_native_speed():
    raw = wav()
    data, seconds = normalize(raw)
    assert seconds == 12
    assert data[:4] == b"RIFF"
    assert validate_payload(payload(raw), raw)["duration_factor"] == pytest.approx(2 / 3)
    for bad in [b"not audio", wav(2), wav(61)]:
        with pytest.raises(ValueError):
            normalize(bad)
    for speed in [True, 0, 3, float("nan")]:
        with pytest.raises(ValueError):
            validate_payload({**payload(raw), "speed": speed}, raw)
    with pytest.raises(ValueError):
        validate_payload({**payload(raw), "model": "IndexTTS-2"}, raw)
    with pytest.raises(ValueError):
        validate_payload(payload(raw), b"changed")


def test_model_output_is_mp3_and_arguments_are_natural(capsys):
    class Model:
        def infer(self, **kwargs):
            print("private synthetic input must not reach logs")
            assert kwargs["duration_factor"] == pytest.approx(2 / 3)
            assert kwargs["use_emo_text"] is False
            assert kwargs["use_random"] is False
            Path(kwargs["output_path"]).write_bytes(wav())
    result = synthesize(Model(), payload(wav()), wav())
    assert result[:3] == b"ID3"
    assert capsys.readouterr().out == ""


def test_duplicate_dispatch_and_worker_delivery():
    request = register()
    calls = []
    spawn = lambda *args: calls.append(args)
    assert ledger.dispatch(OWNER, request, spawn) == "queued"
    assert ledger.dispatch(OWNER, request, spawn) == "queued"
    assert len(calls) == 1
    assert ledger.claim(OWNER, request)
    assert ledger.claim(OWNER, request) is None
    ledger.finish(OWNER, request, b"ID3test")
    assert ledger.dispatch(OWNER, request, spawn) == "ready"
    assert ledger.read_audio(OWNER, request) == b"ID3test"
    assert ledger.read_audio("b" * 32, request) is None


def test_spawn_ack_loss_never_resubmits():
    request = register()
    def spawn(*args):
        raise TimeoutError("Lost acknowledgement")
    assert ledger.dispatch(OWNER, request, spawn) == "dispatching"
    assert ledger.dispatch(OWNER, request, lambda *_: pytest.fail("duplicate spawn")) == "dispatching"
    # Original delayed delivery may still finish once.
    assert ledger.claim(OWNER, request)
    ledger.finish(OWNER, request, b"ID3test")
    assert ledger.read_audio(OWNER, request)


def test_deadline_rejects_late_delivery_and_completion():
    request = register()
    ledger.dispatch(OWNER, request, lambda *_: None)
    ledger.claim(OWNER, request)
    with ledger.connection() as conn:
        conn.execute("UPDATE indextts_requests SET deadline=now()-interval '1 second'")
    assert ledger.dispatch(OWNER, request, lambda *_: pytest.fail("duplicate")) == "uncertain"
    ledger.finish(OWNER, request, b"ID3late")
    assert ledger.read_audio(OWNER, request) is None
    assert ledger.claim(OWNER, request) is None


def test_budget_guard_and_result_retention(monkeypatch):
    monkeypatch.setenv("INDEXTTS_REQUEST_LIMIT", "1")
    first = register()
    ledger.dispatch(OWNER, first, lambda *_: None)
    assert ledger.dispatch(OWNER, register(), lambda *_: pytest.fail("over budget")) == "error"
    ledger.claim(OWNER, first)
    ledger.finish(OWNER, first, b"ID3test")
    with ledger.connection() as conn:
        conn.execute("UPDATE indextts_requests SET created_at=now()-interval '2 days'")
    assert ledger.dispatch(OWNER, first, lambda *_: pytest.fail("expired replay")) == "collected"
    assert ledger.read_audio(OWNER, first) is None


def test_http_contract_and_namespace():
    client = TestClient(create_app(lambda *_: None))
    assert client.get("/health").json()["model"] == MODEL
    assert client.post("/normalize", content=b"bad").status_code == 422
    response = client.post("/normalize", content=wav())
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-audio-seconds"] == "12.0"
    request = register()
    assert client.post(f"/requests/{OWNER}/{request}").json()["status"] == "queued"
    assert client.post(f"/requests/{'b' * 32}/{request}").status_code == 404
    assert client.post("/requests/wrong/wrong").status_code == 422
    assert client.get(f"/requests/{OWNER}/{request}/audio").status_code == 404
