"""
AirLLM server for Devon AI.

Runs one open model with AirLLM (https://github.com/lyogavin/airllm), which
streams the model through the GPU one layer at a time so a 70B+ model fits in a
few GB of VRAM, and serves it over an OpenAI-compatible chat API:

    GET  /health                 state of the model and the queue (no key needed)
    GET  /v1/models              the loaded model
    POST /v1/chat/completions    chat, streamed (SSE) or buffered

Devon's /ai-chat route (agents/ai-chat/_airllm.ts) calls this server-to-server
when someone picks "AirLLM" in Devon AI. Anything else that speaks the OpenAI
chat format can call it too.

AirLLM reads every layer from disk for every generated token, so it is slow:
expect seconds to minutes per token for big models, depending on the disk, the
GPU and compression. This server is built around that:

  * one generation at a time (the GPU is the bottleneck), with a short queue;
    extra requests get 503 "busy" instead of piling up;
  * streamed replies send keepalive comments while queued, while the prompt is
    processed and between slow tokens, so proxies and fetch() don't time out;
  * a client that disconnects (Devon's Stop button) cancels its generation at
    the next token, and AIRLLM_MAX_SECONDS caps any single reply.

Configuration is all environment variables; see .env.example.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

log = logging.getLogger("airllm-server")

ROLES = {"system", "user", "assistant"}
MAX_MESSAGES = 64
MAX_TOTAL_CHARS = 200_000


# ── Settings ─────────────────────────────────────────────────────────────────


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    raw = _env(name)
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise SystemExit(f"{name} must be a whole number, got {raw!r}")
    return max(minimum, value)


def _env_float(name: str, default: float, minimum: float = 0.0) -> float:
    raw = _env(name)
    try:
        value = float(raw) if raw else default
    except ValueError:
        raise SystemExit(f"{name} must be a number, got {raw!r}")
    return max(minimum, value)


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name).lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    backend: str = "airllm"
    model: str = ""
    api_key: str = ""
    allow_no_auth: bool = False
    host: str = "0.0.0.0"
    port: int = 8790
    # AirLLM.from_pretrained options
    compression: Optional[str] = None
    device: Optional[str] = None
    shards_path: Optional[str] = None
    delete_original: bool = False
    prefetching: bool = True
    hf_token: Optional[str] = None
    # Request limits
    max_new_tokens: int = 512
    default_max_tokens: int = 256
    default_temperature: float = 0.6
    max_input_tokens: int = 4096
    max_queue: int = 2
    queue_timeout: float = 900.0
    max_seconds: float = 1800.0
    keepalive_seconds: float = 10.0
    chat_template_kwargs: dict = field(default_factory=dict)
    echo_delay: float = 0.05

    @classmethod
    def from_env(cls) -> "Settings":
        backend = _env("AIRLLM_BACKEND", "airllm").lower()
        if backend not in {"airllm", "echo"}:
            raise SystemExit("AIRLLM_BACKEND must be 'airllm' or 'echo'")
        compression = _env("AIRLLM_COMPRESSION").lower() or None
        if compression not in {None, "4bit", "8bit"}:
            raise SystemExit("AIRLLM_COMPRESSION must be empty, '4bit' or '8bit'")
        kwargs_raw = _env("AIRLLM_CHAT_TEMPLATE_KWARGS")
        try:
            template_kwargs = json.loads(kwargs_raw) if kwargs_raw else {}
        except json.JSONDecodeError as e:
            raise SystemExit(f"AIRLLM_CHAT_TEMPLATE_KWARGS must be a JSON object: {e}")
        if not isinstance(template_kwargs, dict):
            raise SystemExit("AIRLLM_CHAT_TEMPLATE_KWARGS must be a JSON object")
        s = cls(
            backend=backend,
            model=_env("AIRLLM_MODEL") or ("echo" if backend == "echo" else ""),
            api_key=_env("AIRLLM_API_KEY"),
            allow_no_auth=_env_bool("AIRLLM_ALLOW_NO_AUTH", False),
            host=_env("AIRLLM_HOST", "0.0.0.0"),
            port=_env_int("AIRLLM_PORT", 8790, 1),
            compression=compression,
            device=_env("AIRLLM_DEVICE") or None,
            shards_path=_env("AIRLLM_SHARDS_PATH") or None,
            delete_original=_env_bool("AIRLLM_DELETE_ORIGINAL", False),
            prefetching=_env_bool("AIRLLM_PREFETCHING", True),
            hf_token=_env("HF_TOKEN") or None,
            max_new_tokens=_env_int("AIRLLM_MAX_NEW_TOKENS", 512, 1),
            default_max_tokens=_env_int("AIRLLM_DEFAULT_MAX_TOKENS", 256, 1),
            default_temperature=_env_float("AIRLLM_DEFAULT_TEMPERATURE", 0.6),
            max_input_tokens=_env_int("AIRLLM_MAX_INPUT_TOKENS", 4096, 64),
            max_queue=_env_int("AIRLLM_MAX_QUEUE", 2, 0),
            queue_timeout=_env_float("AIRLLM_QUEUE_TIMEOUT", 900.0, 1.0),
            max_seconds=_env_float("AIRLLM_MAX_SECONDS", 1800.0, 1.0),
            keepalive_seconds=_env_float("AIRLLM_KEEPALIVE_SECONDS", 10.0, 0.05),
            chat_template_kwargs=template_kwargs,
            echo_delay=_env_float("AIRLLM_ECHO_DELAY", 0.05),
        )
        s.default_max_tokens = min(s.default_max_tokens, s.max_new_tokens)
        if s.backend == "airllm" and not s.model:
            raise SystemExit("Set AIRLLM_MODEL to a Hugging Face repo ID or a local model folder.")
        if not s.api_key and not s.allow_no_auth:
            raise SystemExit(
                "Set AIRLLM_API_KEY (Devon sends it as a Bearer token). To run without a key on a "
                "machine nobody else can reach, set AIRLLM_ALLOW_NO_AUTH=1 instead."
            )
        return s


# ── Backends ─────────────────────────────────────────────────────────────────


class ClientError(Exception):
    """A problem with the request itself (sent back as 400)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class GenParams:
    max_new_tokens: int
    temperature: float
    top_p: float


@dataclass
class GenResult:
    prompt_tokens: int
    completion_tokens: int
    finish_reason: str  # "stop" | "length" | "cancelled"
    dropped_messages: int = 0


TextSink = Callable[[str], None]


def _plain_transcript(messages: list[dict]) -> str:
    """Fallback prompt for tokenizers without a chat template (base models)."""
    names = {"system": "System", "user": "User", "assistant": "Assistant"}
    lines = [f"{names[m['role']]}: {m['content']}" for m in messages]
    return "\n\n".join(lines) + "\n\nAssistant:"


def _fold_system(messages: list[dict]) -> list[dict]:
    """Merge system text into the first user turn, for templates that reject a system role."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    rest = [dict(m) for m in messages if m["role"] != "system"]
    if system:
        for m in rest:
            if m["role"] == "user":
                m["content"] = f"{system}\n\n{m['content']}"
                break
        else:
            rest.insert(0, {"role": "user", "content": system})
    return rest


class Backend:
    name = "base"
    model_name = ""

    def load(self) -> None:
        raise NotImplementedError

    def encode(self, messages: list[dict]) -> list[int]:
        raise NotImplementedError

    def run(self, ids: list[int], params: GenParams, cancel: threading.Event, sink: TextSink) -> tuple[int, str]:
        """Generate from prompt ids, calling sink() with text as it's produced.

        Blocks until done. Returns (completion_tokens, finish_reason). Must stop
        promptly (at the next token) once cancel is set.
        """
        raise NotImplementedError

    def fit(self, messages: list[dict], max_input_tokens: int) -> tuple[list[int], int]:
        """Encode, dropping the oldest turns (never system or the last message) until it fits."""
        msgs = list(messages)
        dropped = 0
        while True:
            ids = self.encode(msgs)
            if len(ids) <= max_input_tokens:
                return ids, dropped
            oldest = next((i for i, m in enumerate(msgs[:-1]) if m["role"] != "system"), None)
            if oldest is None:
                raise ClientError(
                    "context_length_exceeded",
                    f"The prompt is {len(ids)} tokens; this server accepts up to {max_input_tokens} "
                    "(AIRLLM_MAX_INPUT_TOKENS). Shorten the message or the page text.",
                )
            del msgs[oldest]
            dropped += 1

    def generate(self, messages: list[dict], params: GenParams, max_input_tokens: int,
                 cancel: threading.Event, sink: TextSink) -> GenResult:
        ids, dropped = self.fit(messages, max_input_tokens)
        completion, finish = self.run(ids, params, cancel, sink)
        return GenResult(len(ids), completion, finish, dropped)


class EchoBackend(Backend):
    """No model: repeats the last user message word by word. For testing the wiring."""

    name = "echo"

    def __init__(self, settings: Settings):
        self.delay = settings.echo_delay
        self.model_name = settings.model or "echo"

    def load(self) -> None:
        pass

    def encode(self, messages: list[dict]) -> list[int]:
        # One "token" per word, so AIRLLM_MAX_INPUT_TOKENS can be exercised without a tokenizer
        words = _plain_transcript(messages).split()
        return list(range(len(words)))

    def generate(self, messages, params, max_input_tokens, cancel, sink):
        self._last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        return super().generate(messages, params, max_input_tokens, cancel, sink)

    def run(self, ids, params, cancel, sink):
        words = f"(echo) You said: {self._last}".split(" ")
        produced = 0
        for i, word in enumerate(words):
            if cancel.is_set():
                return produced, "cancelled"
            if produced >= params.max_new_tokens:
                return produced, "length"
            sink(word if i == 0 else f" {word}")
            produced += 1
            if self.delay:
                time.sleep(self.delay)
        return produced, "stop"


class AirLLMBackend(Backend):
    name = "airllm"

    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_name = settings.model
        self.model: Any = None
        self.tokenizer: Any = None
        self.is_mlx = False

    def load(self) -> None:
        from airllm import AutoModel  # heavy import, deferred so /health answers while loading

        s = self.settings
        kwargs: dict[str, Any] = {}
        if s.compression:
            kwargs["compression"] = s.compression
        if s.shards_path:
            kwargs["layer_shards_saving_path"] = s.shards_path
        if s.hf_token:
            kwargs["hf_token"] = s.hf_token
        if s.device:
            kwargs["device"] = s.device
        if s.delete_original:
            kwargs["delete_original"] = True
        if not s.prefetching:
            kwargs["prefetching"] = False
        log.info("loading %s with AirLLM %s (first run downloads and splits the checkpoint; this can take a long time)",
                 s.model, json.dumps({k: v for k, v in kwargs.items() if k != "hf_token"}))
        self.model = AutoModel.from_pretrained(s.model, **kwargs)
        self.tokenizer = self.model.tokenizer
        # On macOS AirLLM runs an MLX port with its own token loop instead of transformers' generate()
        self.is_mlx = type(self.model).__name__ == "AirLLMLlamaMlx"

    def encode(self, messages: list[dict]) -> list[int]:
        tok = self.tokenizer
        if getattr(tok, "chat_template", None):
            # Render to text, then tokenize: apply_chat_template(tokenize=True) changed its return
            # type across transformers versions, and the template already contains BOS if needed.
            try:
                text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True,
                                               **self.settings.chat_template_kwargs)
            except Exception:
                # Some templates (older Gemma/Mistral) raise on a system role
                text = tok.apply_chat_template(_fold_system(messages), tokenize=False, add_generation_prompt=True,
                                               **self.settings.chat_template_kwargs)
            return list(tok(text, add_special_tokens=False)["input_ids"])
        return list(tok(_plain_transcript(messages), add_special_tokens=True)["input_ids"])

    def _eos_ids(self) -> set[int]:
        ids: set[int] = set()
        for source in (getattr(self.model, "generation_config", None), self.tokenizer):
            eos = getattr(source, "eos_token_id", None)
            if isinstance(eos, int):
                ids.add(eos)
            elif isinstance(eos, (list, tuple)):
                ids.update(i for i in eos if isinstance(i, int))
        return ids

    def run(self, ids, params, cancel, sink):
        if self.is_mlx:
            return self._run_mlx(ids, params, cancel, sink)
        return self._run_transformers(ids, params, cancel, sink)

    def _run_transformers(self, ids, params, cancel, sink):
        import torch
        from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

        class Cancelled(StoppingCriteria):
            def __call__(self, input_ids, scores, **kwargs):
                return torch.full((input_ids.shape[0],), cancel.is_set(), dtype=torch.bool, device=input_ids.device)

        device = getattr(self.model, "device", None) or "cpu"
        input_ids = torch.tensor([ids], dtype=torch.long, device=device)
        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)
        gen_kwargs: dict[str, Any] = {
            "input_ids": input_ids,
            "attention_mask": torch.ones_like(input_ids),
            "max_new_tokens": params.max_new_tokens,
            "streamer": streamer,
            "stopping_criteria": StoppingCriteriaList([Cancelled()]),
            "use_cache": True,
        }
        if params.temperature > 0:
            gen_kwargs.update(do_sample=True, temperature=params.temperature, top_p=params.top_p)
        else:
            gen_kwargs.update(do_sample=False)
        if getattr(self.tokenizer, "pad_token_id", None) is None and getattr(self.tokenizer, "eos_token_id", None) is not None:
            gen_kwargs["pad_token_id"] = self.tokenizer.eos_token_id

        outcome: dict[str, Any] = {}

        def worker():
            try:
                outcome["output"] = self.model.generate(**gen_kwargs)
            except BaseException as e:  # noqa: BLE001 - reported to the caller below
                outcome["error"] = e
                streamer.end()  # unblock the reader below

        thread = threading.Thread(target=worker, name="airllm-generate", daemon=True)
        thread.start()
        for text in streamer:
            if text:
                sink(text)
        thread.join()
        if "error" in outcome:
            raise outcome["error"]

        output = outcome.get("output")
        sequences = getattr(output, "sequences", output)
        completion = 0
        last_token = None
        if sequences is not None and hasattr(sequences, "shape"):
            completion = max(0, int(sequences.shape[-1]) - len(ids))
            if completion:
                last_token = int(sequences[0, -1])
        if cancel.is_set():
            return completion, "cancelled"
        if completion >= params.max_new_tokens and last_token not in self._eos_ids():
            return completion, "length"
        return completion, "stop"

    def _run_mlx(self, ids, params, cancel, sink):
        import mlx.core as mx

        eos = self._eos_ids()
        x = mx.array([ids])
        tokens: list[int] = []
        emitted = ""
        for token in self.model.model_generate(x, temperature=params.temperature):
            if cancel.is_set():
                return len(tokens), "cancelled"
            tid = int(token.item())
            if tid in eos:
                return len(tokens), "stop"
            tokens.append(tid)
            # Decode the whole run and send the new suffix, so multi-byte characters split
            # across tokens come out whole
            text = self.tokenizer.decode(tokens, skip_special_tokens=True)
            if not text.endswith("�") and len(text) > len(emitted):
                sink(text[len(emitted):])
                emitted = text
            if len(tokens) >= params.max_new_tokens:
                return len(tokens), "length"
        return len(tokens), "stop"


# ── Scheduler: one generation at a time, short queue ─────────────────────────


class Engine:
    def __init__(self, settings: Settings, backend: Backend):
        self.settings = settings
        self.backend = backend
        self.state = "loading"  # loading | ready | error
        self.error = ""
        self.lock = asyncio.Lock()
        self.waiting = 0
        self.served = 0

    def load_in_background(self) -> threading.Thread:
        def load():
            started = time.time()
            try:
                self.backend.load()
                self.state = "ready"
                log.info("model ready after %.0fs", time.time() - started)
            except BaseException as e:  # noqa: BLE001 - surfaced through /health
                self.state = "error"
                self.error = f"{type(e).__name__}: {e}"
                log.exception("model failed to load")

        thread = threading.Thread(target=load, name="airllm-load", daemon=True)
        thread.start()
        return thread

    def full(self) -> bool:
        """True when a generation is running and the queue behind it is already full."""
        return self.lock.locked() and self.waiting >= self.settings.max_queue

    async def events(self, messages: list[dict], params: GenParams,
                     is_disconnected: Callable[[], Any]) -> AsyncIterator[tuple]:
        """Yield ("queued", n) / ("keepalive",) / ("text", str) / ("done", GenResult) / ("error", code, msg)."""
        loop = asyncio.get_running_loop()
        s = self.settings

        # The handler already answered 503 if full; this re-check closes the gap between that
        # check and this generator starting (it runs with no await before it, so it's atomic).
        if self.full():
            yield ("error", "busy", "AirLLM is busy with other replies. Try again in a few minutes.")
            return

        if not self.lock.locked():
            await self.lock.acquire()  # free: returns at once, no suspension
        else:
            # Wait for the GPU. One acquire task, so a timeout or disconnect can't leak the lock.
            self.waiting += 1
            acquire = asyncio.ensure_future(self.lock.acquire())
            acquired = False
            try:
                yield ("queued", self.waiting)
                deadline = loop.time() + s.queue_timeout
                while True:
                    done, _ = await asyncio.wait({acquire}, timeout=s.keepalive_seconds)
                    if done:
                        acquired = True
                        break
                    if await is_disconnected():
                        return
                    if loop.time() > deadline:
                        yield ("error", "busy", "AirLLM is still busy with earlier replies. Try again in a few minutes.")
                        return
                    yield ("keepalive",)
            finally:
                self.waiting -= 1
                if not acquired:
                    acquire.cancel()
                    if acquire.done() and not acquire.cancelled():
                        self.lock.release()

        # The lock is released when the generation thread actually finishes, not when this
        # generator exits: after a disconnect the GPU is still busy until the current token ends.
        cancel = threading.Event()
        queue: asyncio.Queue = asyncio.Queue()
        def sink(text: str) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, ("text", text))

        def finished(_f) -> None:
            self.served += 1
            self.lock.release()
            queue.put_nowait(("finished",))

        try:
            future = loop.run_in_executor(None, self.backend.generate, messages, params, s.max_input_tokens, cancel, sink)
        except BaseException:
            self.lock.release()
            raise
        future.add_done_callback(finished)

        started = loop.time()
        timed_out = False
        try:
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=s.keepalive_seconds)
                except asyncio.TimeoutError:
                    item = ("keepalive",)
                if not timed_out and loop.time() - started > s.max_seconds:
                    timed_out = True
                    cancel.set()
                if item[0] == "finished":
                    break
                if item[0] == "keepalive":
                    if await is_disconnected():
                        cancel.set()
                        return
                yield item
            try:
                result: GenResult = future.result()
            except ClientError as e:
                yield ("error", e.code, e.message)
                return
            except Exception as e:  # noqa: BLE001
                log.exception("generation failed")
                yield ("error", "generation_failed", f"The model failed while generating: {type(e).__name__}: {e}")
                return
            if timed_out:
                result.finish_reason = "length"
            yield ("done", result)
        finally:
            cancel.set()


# ── HTTP ─────────────────────────────────────────────────────────────────────


def _error(status: int, code: str, message: str, headers: Optional[dict] = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message, "type": code}}, status_code=status, headers=headers)


def _content_text(content: Any) -> Optional[str]:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI content parts; only text is supported
        parts = []
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "text" or not isinstance(part.get("text"), str):
                return None
            parts.append(part["text"])
        return "\n".join(parts)
    return None


def parse_request(body: Any, settings: Settings) -> tuple[list[dict], GenParams, bool, bool]:
    if not isinstance(body, dict):
        raise ClientError("invalid_request", "The body must be a JSON object.")
    raw = body.get("messages")
    if not isinstance(raw, list) or not raw:
        raise ClientError("invalid_request", "'messages' must be a non-empty array.")
    if len(raw) > MAX_MESSAGES:
        raise ClientError("invalid_request", f"At most {MAX_MESSAGES} messages are accepted.")
    messages: list[dict] = []
    total = 0
    for m in raw:
        if not isinstance(m, dict) or m.get("role") not in ROLES:
            raise ClientError("invalid_request", "Each message needs a role of system, user or assistant.")
        text = _content_text(m.get("content"))
        if text is None:
            raise ClientError("invalid_request", "Message content must be text (images and tool calls aren't supported).")
        total += len(text)
        messages.append({"role": m["role"], "content": text})
    if total > MAX_TOTAL_CHARS:
        raise ClientError("context_length_exceeded", "The messages are too long.")
    if messages[-1]["role"] != "user":
        raise ClientError("invalid_request", "The last message must be from the user.")

    def number(key: str, default: float, low: float, high: float) -> float:
        value = body.get(key, default)
        if value is None:
            value = default
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ClientError("invalid_request", f"'{key}' must be a number.")
        return min(high, max(low, float(value)))

    requested = body.get("max_completion_tokens", body.get("max_tokens"))
    if requested is None:
        max_tokens = settings.default_max_tokens
    elif isinstance(requested, bool) or not isinstance(requested, (int, float)):
        raise ClientError("invalid_request", "'max_tokens' must be a number.")
    else:
        # Capped by AIRLLM_MAX_NEW_TOKENS: every token is a full pass over the model's layers
        max_tokens = int(min(settings.max_new_tokens, max(1, requested)))
    params = GenParams(
        max_new_tokens=max_tokens,
        temperature=number("temperature", settings.default_temperature, 0.0, 2.0),
        top_p=number("top_p", 1.0, 0.01, 1.0),
    )
    stream = bool(body.get("stream", False))
    options = body.get("stream_options")
    include_usage = bool(isinstance(options, dict) and options.get("include_usage"))
    return messages, params, stream, include_usage


def create_app(settings: Settings, backend: Optional[Backend] = None, load: bool = True) -> FastAPI:
    backend = backend or (EchoBackend(settings) if settings.backend == "echo" else AirLLMBackend(settings))
    engine = Engine(settings, backend)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        engine.lock = asyncio.Lock()  # bind to the running loop
        if load:
            engine.load_in_background()
        else:
            engine.state = "ready"
        yield

    app = FastAPI(title="AirLLM server for Devon AI", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.engine = engine

    def authorized(request: Request) -> bool:
        if not settings.api_key:
            return settings.allow_no_auth
        header = request.headers.get("authorization", "")
        given = header[7:].strip() if header.lower().startswith("bearer ") else request.headers.get("x-api-key", "")
        return bool(given) and hmac.compare_digest(given.encode(), settings.api_key.encode())

    def unavailable() -> Optional[JSONResponse]:
        if engine.state == "loading":
            return _error(503, "model_loading", f"AirLLM is still loading {backend.model_name}. The first start downloads and "
                                                "splits the model, which can take a long time; check the server log.",
                          {"Retry-After": "60"})
        if engine.state == "error":
            return _error(503, "model_failed", f"AirLLM couldn't load {backend.model_name}: {engine.error}")
        return None

    @app.get("/health")
    async def health():
        return {
            "ok": engine.state == "ready",
            "state": engine.state,
            "backend": backend.name,
            "model": backend.model_name,
            "busy": engine.lock.locked(),
            "waiting": engine.waiting,
            "max_queue": settings.max_queue,
            "served": engine.served,
            **({"error": engine.error} if engine.error else {}),
        }

    @app.get("/v1/models")
    async def models(request: Request):
        if not authorized(request):
            return _error(401, "unauthorized", "A valid API key is required.")
        return {"object": "list", "data": [{"id": backend.model_name, "object": "model", "owned_by": "airllm"}]}

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        if not authorized(request):
            return _error(401, "unauthorized", "A valid API key is required.")
        try:
            body = await request.json()
        except Exception:
            return _error(400, "invalid_json", "The body must be valid JSON.")
        try:
            messages, params, stream, include_usage = parse_request(body, settings)
        except ClientError as e:
            return _error(400, e.code, e.message)
        blocked = unavailable()
        if blocked:
            return blocked
        if engine.full():
            return _error(503, "busy", "AirLLM is busy with other replies. Try again in a few minutes.", {"Retry-After": "30"})

        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())
        model_name = backend.model_name
        events = engine.events(messages, params, request.is_disconnected)

        if not stream:
            text: list[str] = []
            result: Optional[GenResult] = None
            async for event in events:
                if event[0] == "text":
                    text.append(event[1])
                elif event[0] == "done":
                    result = event[1]
                elif event[0] == "error":
                    return _error(400 if event[1] == "context_length_exceeded" else 503 if event[1] == "busy" else 500,
                                  event[1], event[2])
            if result is None:
                return _error(499, "cancelled", "The request was cancelled.")
            return {
                "id": completion_id,
                "object": "chat.completion",
                "created": created,
                "model": model_name,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "".join(text)},
                             "finish_reason": "length" if result.finish_reason == "length" else "stop"}],
                "usage": {"prompt_tokens": result.prompt_tokens, "completion_tokens": result.completion_tokens,
                          "total_tokens": result.prompt_tokens + result.completion_tokens},
            }

        def chunk(delta: dict, finish: Optional[str] = None) -> str:
            payload = {"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model_name,
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        async def sse() -> AsyncIterator[str]:
            yield chunk({"role": "assistant", "content": ""})
            async for event in events:
                kind = event[0]
                if kind == "keepalive":
                    yield ": keepalive\n\n"
                elif kind == "queued":
                    # SSE comment: ignored by OpenAI clients, shown as a notice by Devon
                    yield f": queued {event[1]}\n\n"
                elif kind == "text":
                    yield chunk({"content": event[1]})
                elif kind == "error":
                    yield f"data: {json.dumps({'error': {'code': event[1], 'message': event[2], 'type': event[1]}})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                elif kind == "done":
                    result: GenResult = event[1]
                    if result.dropped_messages:
                        yield f": trimmed {result.dropped_messages}\n\n"
                    yield chunk({}, "length" if result.finish_reason == "length" else "stop")
                    if include_usage:
                        usage = {"prompt_tokens": result.prompt_tokens, "completion_tokens": result.completion_tokens,
                                 "total_tokens": result.prompt_tokens + result.completion_tokens}
                        payload = {"id": completion_id, "object": "chat.completion.chunk", "created": created,
                                   "model": model_name, "choices": [], "usage": usage}
                        yield f"data: {json.dumps(payload)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

    return app


def main() -> None:
    logging.basicConfig(level=_env("AIRLLM_LOG_LEVEL", "INFO").upper(), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    import uvicorn

    # One process only: the model lives in this process's memory and GPU.
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, workers=1,
                timeout_keep_alive=75, log_level=_env("AIRLLM_LOG_LEVEL", "info").lower())


if __name__ == "__main__":
    main()
