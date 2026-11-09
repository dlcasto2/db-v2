"""
Tests for server.py, run against a real uvicorn server on a local port so
streaming, disconnects and queueing behave as they do in production.

    pip install -r requirements.txt pytest httpx
    pytest -q test_server.py

The model is replaced by the echo backend (no GPU or download needed). To also
smoke-test real AirLLM on a model you already have on disk:

    AIRLLM_TEST_MODEL=/path/to/model pytest -q test_server.py -k real
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time

import httpx
import pytest
import uvicorn

import server
from server import EchoBackend, Settings, create_app

KEY = "test-key-0123456789"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Running:
    def __init__(self, settings: Settings, backend=None, load: bool = False):
        self.port = free_port()
        settings.host, settings.port = "127.0.0.1", self.port
        self.app = create_app(settings, backend, load=load)
        self.server = uvicorn.Server(uvicorn.Config(self.app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def __enter__(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started:
            if time.time() > deadline:
                raise RuntimeError("server didn't start")
            time.sleep(0.02)
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)


def settings(**overrides) -> Settings:
    s = Settings(backend="echo", model="echo", api_key=KEY, echo_delay=0.0, keepalive_seconds=0.2)
    for k, v in overrides.items():
        setattr(s, k, v)
    return s


AUTH = {"Authorization": f"Bearer {KEY}"}


def chat_body(text="hello there", **extra):
    return {"messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": text}], **extra}


def read_sse(response: httpx.Response):
    """Return (data payloads, comment lines) from an SSE response."""
    data, comments = [], []
    for line in response.iter_lines():
        if line.startswith("data: "):
            payload = line[6:]
            data.append(payload if payload == "[DONE]" else json.loads(payload))
        elif line.startswith(":"):
            comments.append(line)
    return data, comments


def stream_text(data) -> str:
    return "".join(d["choices"][0]["delta"].get("content", "") for d in data if isinstance(d, dict) and d.get("choices"))


# ── Settings ────────────────────────────────────────────────────────────────


def test_settings_require_a_key_unless_explicitly_open(monkeypatch):
    for name in list(os.environ):
        if name.startswith("AIRLLM_"):
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AIRLLM_MODEL", "some/model")
    with pytest.raises(SystemExit, match="AIRLLM_API_KEY"):
        Settings.from_env()
    monkeypatch.setenv("AIRLLM_ALLOW_NO_AUTH", "1")
    assert Settings.from_env().allow_no_auth is True
    monkeypatch.setenv("AIRLLM_API_KEY", "k")
    monkeypatch.delenv("AIRLLM_MODEL")
    with pytest.raises(SystemExit, match="AIRLLM_MODEL"):
        Settings.from_env()


def test_settings_validate_values(monkeypatch):
    monkeypatch.setenv("AIRLLM_API_KEY", "k")
    monkeypatch.setenv("AIRLLM_MODEL", "m")
    monkeypatch.setenv("AIRLLM_COMPRESSION", "2bit")
    with pytest.raises(SystemExit, match="COMPRESSION"):
        Settings.from_env()
    monkeypatch.setenv("AIRLLM_COMPRESSION", "4bit")
    monkeypatch.setenv("AIRLLM_CHAT_TEMPLATE_KWARGS", "[1]")
    with pytest.raises(SystemExit, match="JSON object"):
        Settings.from_env()
    monkeypatch.setenv("AIRLLM_CHAT_TEMPLATE_KWARGS", '{"enable_thinking": false}')
    monkeypatch.setenv("AIRLLM_MAX_NEW_TOKENS", "100")
    monkeypatch.setenv("AIRLLM_DEFAULT_MAX_TOKENS", "999")
    s = Settings.from_env()
    assert s.compression == "4bit" and s.chat_template_kwargs == {"enable_thinking": False}
    assert s.default_max_tokens == 100  # never above the hard cap


# ── Auth and validation ─────────────────────────────────────────────────────


def test_auth_is_required_and_health_is_public():
    with Running(settings()) as srv:
        assert httpx.get(f"{srv.url}/health").json()["state"] == "ready"
        assert httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body()).status_code == 401
        bad = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers={"Authorization": "Bearer nope"})
        assert bad.status_code == 401 and bad.json()["error"]["code"] == "unauthorized"
        assert httpx.get(f"{srv.url}/v1/models").status_code == 401
        assert httpx.get(f"{srv.url}/v1/models", headers={"x-api-key": KEY}).json()["data"][0]["id"] == "echo"


def test_open_mode_needs_no_key():
    with Running(settings(api_key="", allow_no_auth=True)) as srv:
        assert httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body()).status_code == 200


@pytest.mark.parametrize(
    "body, code",
    [
        ({"messages": []}, "invalid_request"),
        ({"messages": [{"role": "tool", "content": "x"}]}, "invalid_request"),
        ({"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]}, "invalid_request"),
        ({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]}, "invalid_request"),
        (chat_body(max_tokens="lots"), "invalid_request"),
        (chat_body(temperature=True), "invalid_request"),
        ({"messages": [{"role": "user", "content": "x" * 200_001}]}, "context_length_exceeded"),
    ],
)
def test_bad_requests_are_rejected(body, code):
    with Running(settings()) as srv:
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=body, headers=AUTH)
        assert r.status_code == 400 and r.json()["error"]["code"] == code


def test_text_content_parts_are_accepted():
    with Running(settings()) as srv:
        body = {"messages": [{"role": "user", "content": [{"type": "text", "text": "part one"}, {"type": "text", "text": "two"}]}]}
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=body, headers=AUTH)
        assert r.json()["choices"][0]["message"]["content"] == "(echo) You said: part one\ntwo"


# ── Replies ─────────────────────────────────────────────────────────────────


def test_buffered_reply_matches_openai_shape():
    with Running(settings()) as srv:
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body("how are you"), headers=AUTH)
        body = r.json()
        assert r.status_code == 200 and body["object"] == "chat.completion"
        assert body["choices"][0]["message"] == {"role": "assistant", "content": "(echo) You said: how are you"}
        assert body["choices"][0]["finish_reason"] == "stop"
        assert body["usage"]["completion_tokens"] == 6 and body["usage"]["total_tokens"] > 6


def test_streamed_reply_matches_openai_shape():
    with Running(settings()) as srv:
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", headers=AUTH,
                          json=chat_body("stream me", stream=True, stream_options={"include_usage": True})) as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            data, _ = read_sse(r)
    assert data[0]["choices"][0]["delta"]["role"] == "assistant"
    assert stream_text(data) == "(echo) You said: stream me"
    assert data[-1] == "[DONE]"
    finals = [d for d in data[:-1] if d["choices"] and d["choices"][0]["finish_reason"]]
    assert len(finals) == 1 and finals[0]["choices"][0]["finish_reason"] == "stop"
    assert data[-2]["choices"] == [] and data[-2]["usage"]["completion_tokens"] == 5


def test_max_tokens_is_capped_and_reported_as_length():
    with Running(settings(max_new_tokens=3)) as srv:
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body("one two three four five", max_tokens=50), headers=AUTH)
        choice = r.json()["choices"][0]
        assert choice["message"]["content"] == "(echo) You said:" and choice["finish_reason"] == "length"


def test_old_turns_are_dropped_to_fit_but_the_last_message_never_is():
    history = []
    for i in range(6):
        history += [{"role": "user", "content": f"question {i} " + "word " * 20}, {"role": "assistant", "content": "answer " * 20}]
    body = {"messages": [{"role": "system", "content": "sys"}, *history, {"role": "user", "content": "latest"}], "stream": True}
    with Running(settings(max_input_tokens=60)) as srv:
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", json=body, headers=AUTH) as r:
            data, comments = read_sse(r)
        assert stream_text(data) == "(echo) You said: latest"
        assert any(c.startswith(": trimmed") for c in comments)

        too_long = {"messages": [{"role": "user", "content": "word " * 100}]}
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=too_long, headers=AUTH)
        assert r.status_code == 400 and r.json()["error"]["code"] == "context_length_exceeded"
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", json={**too_long, "stream": True}, headers=AUTH) as r:
            data, _ = read_sse(r)
        assert data[-2]["error"]["code"] == "context_length_exceeded" and data[-1] == "[DONE]"


# ── One at a time ───────────────────────────────────────────────────────────


class SlowEcho(EchoBackend):
    """Echo that is slow per word and records whether it was told to stop."""

    def __init__(self, s: Settings, delay: float):
        super().__init__(s)
        self.delay = delay
        self.cancelled = threading.Event()
        self.calls = 0

    def run(self, ids, params, cancel, sink):
        self.calls += 1
        produced, finish = super().run(ids, params, cancel, sink)
        if finish == "cancelled":
            self.cancelled.set()
        return produced, finish


def test_a_full_queue_answers_503_busy():
    s = settings(max_queue=0)
    backend = SlowEcho(s, delay=0.15)
    with Running(s, backend) as srv:
        first = threading.Thread(target=lambda: httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body("a b c d e f"),
                                                           headers=AUTH, timeout=30))
        first.start()
        deadline = time.time() + 5
        while not httpx.get(f"{srv.url}/health").json()["busy"]:
            assert time.time() < deadline
            time.sleep(0.02)
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers=AUTH)
        assert r.status_code == 503 and r.json()["error"]["code"] == "busy" and r.headers["retry-after"] == "30"
        first.join()
        assert httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers=AUTH).status_code == 200


def test_queued_requests_wait_their_turn_with_keepalives():
    s = settings(max_queue=1, keepalive_seconds=0.1)
    backend = SlowEcho(s, delay=0.1)
    with Running(s, backend) as srv:
        results = {}
        first = threading.Thread(target=lambda: results.setdefault(
            "first", httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body("one two three four five six"),
                                headers=AUTH, timeout=30).json()))
        first.start()
        deadline = time.time() + 5
        while not httpx.get(f"{srv.url}/health").json()["busy"]:
            assert time.time() < deadline
            time.sleep(0.02)
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", json=chat_body("second", stream=True),
                          headers=AUTH, timeout=30) as r:
            data, comments = read_sse(r)
        first.join()
    assert ": queued 1" in comments and ": keepalive" in comments
    assert stream_text(data) == "(echo) You said: second"
    assert results["first"]["choices"][0]["message"]["content"].endswith("five six")


def test_closing_the_stream_cancels_generation_and_frees_the_gpu():
    s = settings(keepalive_seconds=0.1)
    backend = SlowEcho(s, delay=0.1)
    long_text = " ".join(f"w{i}" for i in range(200))  # ~20 s if it ran to the end
    with Running(s, backend) as srv:
        started = time.time()
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", json=chat_body(long_text, stream=True), headers=AUTH) as r:
            seen = 0
            for line in r.iter_lines():
                if line.startswith("data: ") and '"content": "' in line:
                    seen += 1
                if seen >= 4:
                    break
        assert backend.cancelled.wait(5), "generation kept running after the client left"
        assert time.time() - started < 8
        deadline = time.time() + 5
        while httpx.get(f"{srv.url}/health").json()["busy"]:
            assert time.time() < deadline, "the GPU lock was never released"
            time.sleep(0.05)
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body("after"), headers=AUTH)
        assert r.json()["choices"][0]["message"]["content"] == "(echo) You said: after"


def test_max_seconds_stops_a_runaway_reply():
    s = settings(max_seconds=0.5, keepalive_seconds=0.1)
    backend = SlowEcho(s, delay=0.1)
    with Running(s, backend) as srv:
        started = time.time()
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(" ".join(["x"] * 100)), headers=AUTH, timeout=30)
        assert time.time() - started < 5
        assert r.json()["choices"][0]["finish_reason"] == "length"


# ── Loading ─────────────────────────────────────────────────────────────────


class SlowLoad(EchoBackend):
    def __init__(self, s, fail=False):
        super().__init__(s)
        self.release = threading.Event()
        self.fail = fail

    def load(self):
        self.release.wait(10)
        if self.fail:
            raise RuntimeError("out of disk space")


def test_requests_wait_for_the_model_to_load():
    s = settings()
    backend = SlowLoad(s)
    with Running(s, backend, load=True) as srv:
        assert httpx.get(f"{srv.url}/health").json()["state"] == "loading"
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers=AUTH)
        assert r.status_code == 503 and r.json()["error"]["code"] == "model_loading" and r.headers["retry-after"]
        backend.release.set()
        deadline = time.time() + 5
        while httpx.get(f"{srv.url}/health").json()["state"] != "ready":
            assert time.time() < deadline
            time.sleep(0.02)
        assert httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers=AUTH).status_code == 200


def test_a_failed_load_is_reported():
    s = settings()
    backend = SlowLoad(s, fail=True)
    backend.release.set()
    with Running(s, backend, load=True) as srv:
        deadline = time.time() + 5
        while httpx.get(f"{srv.url}/health").json()["state"] == "loading":
            assert time.time() < deadline
            time.sleep(0.02)
        health = httpx.get(f"{srv.url}/health").json()
        assert health["state"] == "error" and "out of disk space" in health["error"]
        r = httpx.post(f"{srv.url}/v1/chat/completions", json=chat_body(), headers=AUTH)
        assert r.status_code == 503 and r.json()["error"]["code"] == "model_failed"


# ── Real AirLLM (opt-in) ────────────────────────────────────────────────────


def test_pick_device_prefers_cuda_then_mps_then_cpu(monkeypatch):
    torch = pytest.importorskip("torch")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert server.pick_device() == "cuda:0"
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: True)
    assert server.pick_device() == "mps"
    monkeypatch.setattr(torch.backends.mps, "is_available", lambda: False)
    assert server.pick_device() == "cpu"


@pytest.mark.skipif(not os.environ.get("AIRLLM_TEST_MODEL"), reason="set AIRLLM_TEST_MODEL to a local model folder")
def test_real_airllm_streams_and_cancels():
    s = Settings(backend="airllm", model=os.environ["AIRLLM_TEST_MODEL"], api_key=KEY, keepalive_seconds=1.0,
                 device=os.environ.get("AIRLLM_TEST_DEVICE") or None,  # unset: exercises pick_device()
                 shards_path=os.environ.get("AIRLLM_TEST_SHARDS") or None)
    with Running(s, load=True) as srv:
        deadline = time.time() + 900
        while (state := httpx.get(f"{srv.url}/health").json())["state"] == "loading":
            assert time.time() < deadline
            time.sleep(1)
        assert state["state"] == "ready", state
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", headers=AUTH, timeout=600,
                          json=chat_body("Say hi.", stream=True, max_tokens=12, temperature=0,
                                         stream_options={"include_usage": True})) as r:
            data, _ = read_sse(r)
        assert data[-1] == "[DONE]" and "error" not in data[-2], data[-2]
        usage = data[-2]["usage"]
        assert 0 < usage["completion_tokens"] <= 12 and usage["prompt_tokens"] > 0
        assert stream_text(data)  # some text came out

        # Leave mid-generation on a timer: text can arrive in one flush at the end (the streamer
        # waits for word boundaries), so waiting for content could let the reply finish first.
        started = time.time()
        with httpx.stream("POST", f"{srv.url}/v1/chat/completions", headers=AUTH, timeout=600,
                          json=chat_body("Count to a thousand.", stream=True, max_tokens=500, temperature=0)) as r:
            lines = r.iter_lines()  # keep a reference: a discarded iterator closes the connection
            next(lines)  # the role chunk: generation has started
            time.sleep(3)
            assert httpx.get(f"{srv.url}/health").json()["busy"], "reply finished before the test could cancel it"
        left = time.time()
        deadline = time.time() + 120
        while httpx.get(f"{srv.url}/health").json()["busy"]:
            assert time.time() < deadline, "cancel didn't stop the real model"
            time.sleep(0.1)
        stopped_after = time.time() - left
        print(f"\nreal AirLLM: stopped {stopped_after:.1f}s after the client left ({left - started:.1f}s into the reply)")
        assert stopped_after < 15, "cancel took far longer than one token"
