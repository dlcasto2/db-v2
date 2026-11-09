# airllm-server

Runs one open model with [AirLLM](https://github.com/lyogavin/airllm) and serves
it to Devon AI's **AirLLM** provider. AirLLM keeps only one layer of the model
on the GPU at a time and streams the rest from disk, so models far bigger than
your VRAM still run (its README lists Llama 3 70B in about 4 GB of VRAM).

```
Devon (Vercel / EdgeOne / devon-ai-api)            your GPU machine
  /ai-chat  ── model: "airllm" ──►  agents/ai-chat/_airllm.ts ──HTTPS──►  airllm-server  ──►  AirLLM
            ◄── Devon SSE ────────                              ◄─ OpenAI SSE ─
```

Devon calls this server from its own backend with a shared key; visitors never
see the server's address or key. The API is the OpenAI chat-completions format,
so other OpenAI-compatible clients can use it too.

## Before you start: it is slow

AirLLM trades speed for memory. Every generated token runs the whole model, and
that means reading every layer from disk (or from the OS page cache, if the
machine has enough RAM to hold the split model). A rough guide is the model's
size on disk divided by your disk's read speed, per token:

| Model | Size on disk | At ~3 GB/s (NVMe) |
| --- | --- | --- |
| 8B, 16-bit | ~16 GB | ~5 s per token |
| 70B, 16-bit | ~140 GB | ~45 s per token |
| 70B, `AIRLLM_COMPRESSION=4bit` | ~35–40 GB | ~12 s per token |

So a 100-token answer from a 70B model can take many minutes. Devon's defaults
are tuned for that: short replies (`DEVON_AIRLLM_MAX_TOKENS=384`, capped again
here by `AIRLLM_MAX_NEW_TOKENS`), one reply at a time with a short queue, a
notice in the chat after 20 s of waiting, and Stop cancelling the generation at
the next token. For something that feels interactive, pick a smaller model or
use compression; for the biggest models, expect "leave it and come back".

Also plan disk space: the first start downloads the checkpoint and AirLLM writes
a per-layer copy, so you need about twice the model's size free
(`AIRLLM_DELETE_ORIGINAL=1` deletes the download after splitting).

## Run it

Python 3.10+, and an NVIDIA GPU (Linux), an Apple-silicon Mac, or a CPU (very
slow). On macOS, AirLLM only runs Llama-style models (`LlamaForCausalLM`,
`MistralForCausalLM`) and needs `pip install mlx`.

```sh
cd airllm-server
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt          # plus bitsandbytes for compression
cp .env.example .env                     # set AIRLLM_MODEL and AIRLLM_API_KEY
set -a; . ./.env; set +a
python server.py
```

`GET /health` answers right away with `"state": "loading"` while the model
downloads and splits (watch the log), then `"ready"`. Requests before then get
`503 model_loading`, which Devon shows as "AirLLM is still loading its model".

With Docker (NVIDIA Container Toolkit installed on the host):

```sh
docker build -t devon-airllm airllm-server
docker run --gpus all -p 8790:8790 --env-file airllm-server/.env -v airllm-data:/data devon-airllm
```

The `/data` volume keeps the download and the split layers between restarts.

### Try the wiring first

`AIRLLM_BACKEND=echo` skips the model and repeats your message back word by
word. Use it to check Devon ↔ server end to end before committing hours to a
download:

```sh
AIRLLM_BACKEND=echo AIRLLM_API_KEY=test python server.py
```

## Connect Devon

1. Put the server somewhere Devon's backend can reach over HTTPS: a reverse
   proxy with a certificate on the GPU machine, or a tunnel (Cloudflare Tunnel,
   Tailscale Funnel, ngrok…) to `localhost:8790`. Through a tunnel every request
   looks local, which is why the server requires `AIRLLM_API_KEY` unless you
   explicitly set `AIRLLM_ALLOW_NO_AUTH=1`.
2. In Devon's server environment (EdgeOne, Vercel, or `devon-ai-api`), set:

   | Variable | Meaning |
   | --- | --- |
   | `DEVON_AIRLLM_BASE_URL` | This server, e.g. `https://airllm.example.com` (a `/v1` suffix is fine) |
   | `DEVON_AIRLLM_API_KEY` | The same value as `AIRLLM_API_KEY` here |
   | `DEVON_AIRLLM_MAX_TOKENS` | Optional reply length cap (default 384) |
   | `DEVON_AIRLLM_MAX_PAGE_CHARS` | Optional: page text sent with "ask about this page" (default 6000) |
   | `DEVON_AIRLLM_TIMEOUT_SECONDS` | Optional: end replies sooner than Devon's own limit (below) |
   | `DEVON_AIRLLM_MODEL` | Optional model name to send; this server has one model and ignores it |

   Never use a `NEXT_PUBLIC_` name for these.
3. Redeploy Devon, open Devon AI and pick **AirLLM** in the provider menu.

### Time limits

Devon ends an AirLLM reply cleanly 10 s before its function limit, keeping the
text written so far and freeing the GPU: about 290 s on Vercel (`maxDuration =
300` in `app/ai-chat/route.ts`) and 590 s on EdgeOne (`agents.timeout` in
`edgeone.json`). If your Vercel plan's limit is lower, set
`DEVON_AIRLLM_TIMEOUT_SECONDS` a little under it. For long replies from big
models, run [`devon-ai-api`](../devon-ai-api/README.md) on a host without a
request time limit and point Devon at it; set `DEVON_AIRLLM_TIMEOUT_SECONDS`
there to whatever you're willing to wait (the server's own cap is
`AIRLLM_MAX_SECONDS`).

## What the AirLLM provider can do in Devon

It's text chat, like the Eve Agent provider. It sees the page you asked about
("Ask Devon AI about this page") and attached files, plus the last few messages
of the chat. It does not get Devon's tab tools (reading, clicking, typing,
opening tabs), the sandbox, or the web; it says so if asked and suggests
switching to Claude. Messages count toward the same daily limit as the other
providers (`DEVON_AI_DAILY_LIMIT`), which also protects your GPU.

## API

| Route | |
| --- | --- |
| `GET /health` | `{ ok, state, backend, model, busy, waiting, max_queue, served }`, no key needed |
| `GET /v1/models` | The loaded model |
| `POST /v1/chat/completions` | `messages` (text only), `max_tokens`, `temperature`, `top_p`, `stream`, `stream_options.include_usage` |

Authentication is `Authorization: Bearer <AIRLLM_API_KEY>` (or `x-api-key`).
Errors look like OpenAI's: `{ "error": { "code", "message" } }`, with codes
`unauthorized` (401), `invalid_request` / `context_length_exceeded` (400),
`model_loading` / `model_failed` / `busy` (503, with `Retry-After` where it
helps). A streamed reply that fails after it started sends a
`data: {"error": …}` line, then `data: [DONE]`.

Streamed replies also carry SSE comments that OpenAI clients ignore:
`: keepalive` while waiting (so proxies and `fetch` don't time out), `: queued N`
when waiting behind another reply, and `: trimmed N` when older turns were
dropped to fit `AIRLLM_MAX_INPUT_TOKENS`. Devon turns the last two into notices.

Closing the connection cancels the generation at the next token. All settings
are environment variables, documented in [`.env.example`](.env.example).

## Tests

```sh
pip install pytest httpx
pytest -q test_server.py
```

These run against a real local server with the echo backend. To also run the
real AirLLM path on a model you already have on disk:

```sh
AIRLLM_TEST_MODEL=/path/to/model pytest -q test_server.py -k real
```
