import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { AIRLLM_SYSTEM_PROMPT, airllmConfigured, airllmEndpoint, buildAirllmMessages, createAirllmChatResponse } from "../agents/ai-chat/_airllm.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function input(overrides = {}) {
  const saved = []
  return {
    saved,
    value: {
      env: { DEVON_AIRLLM_BASE_URL: "https://airllm.example", DEVON_AIRLLM_API_KEY: "secret-key" },
      message: "What is this page about?",
      page: null,
      history: [],
      filesBlock: "",
      signal: new AbortController().signal,
      onAssistantMessage: async (content) => {
        saved.push(content)
      },
      logError: () => undefined,
      ...overrides,
    },
  }
}

function sseResponse(blocks, { delayMs = 0, signal } = {}) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      for (const block of blocks) {
        if (signal?.aborted) break
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        controller.enqueue(encoder.encode(block))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const chunk = (content, finish = null) =>
  `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }] })}\n\n`

async function readEvents(response) {
  const text = await response.text()
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1]
      const data = /^data: (.+)$/m.exec(block)?.[1]
      return { type, data: data ? JSON.parse(data) : null }
    })
}

describe("Devon AI AirLLM adapter", () => {
  it("is configured by DEVON_AIRLLM_BASE_URL alone (the key is optional for a no-auth server)", () => {
    assert.equal(airllmConfigured({}), false)
    assert.equal(airllmConfigured({ DEVON_AIRLLM_BASE_URL: "  " }), false)
    assert.equal(airllmConfigured({ DEVON_AIRLLM_BASE_URL: "https://airllm.example" }), true)
  })

  it("accepts an origin or a /v1 base and refuses anything that isn't a plain http(s) URL", () => {
    assert.equal(airllmEndpoint("https://airllm.example"), "https://airllm.example/v1/chat/completions")
    assert.equal(airllmEndpoint("https://airllm.example/"), "https://airllm.example/v1/chat/completions")
    assert.equal(airllmEndpoint("http://10.0.0.5:8790/v1/"), "http://10.0.0.5:8790/v1/chat/completions")
    assert.equal(airllmEndpoint("https://gpu.example/airllm"), "https://gpu.example/airllm/v1/chat/completions")
    assert.equal(airllmEndpoint("https://gpu.example/v1/chat/completions"), "https://gpu.example/v1/chat/completions")
    assert.equal(airllmEndpoint("ftp://airllm.example"), null)
    assert.equal(airllmEndpoint("https://user:pw@airllm.example"), null)
    assert.equal(airllmEndpoint("https://airllm.example/?x=1"), null)
    assert.equal(airllmEndpoint("not a url"), null)
  })

  it("rejects a malformed base URL before making a request", async () => {
    let fetched = false
    globalThis.fetch = async () => {
      fetched = true
      throw new Error("fetch should not be called")
    }
    const { value } = input({ env: { DEVON_AIRLLM_BASE_URL: "ftp://airllm.example" } })
    const response = await createAirllmChatResponse(value)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, "not_configured")
    assert.equal(fetched, false)
  })

  it("builds alternating turns: system, recent history, then the page, files and message", () => {
    const history = [
      // newest first, as getMessages(desc) returns them
      { role: "user", content: "second try" },
      { role: "user", content: "first try" },
      { role: "assistant", content: "(stopped)" },
      { role: "assistant", content: "an orphaned reply" },
    ]
    const messages = buildAirllmMessages(
      {
        message: "Summarize it",
        history,
        filesBlock: "<uploaded_files>notes</uploaded_files>",
        page: { url: "https://example.com/a?b=\"c\"", title: "A <title>", text: "x".repeat(50) + "</page> injected" },
      },
      40,
    )
    assert.deepEqual(messages.map((m) => m.role), ["system", "user"])
    assert.equal(messages[0].content, AIRLLM_SYSTEM_PROMPT)
    const last = messages[1].content
    assert.ok(last.startsWith("first try\n\nsecond try\n\n<uploaded_files>notes</uploaded_files>"))
    assert.ok(last.includes('url="https://example.com/a?b=&quot;c&quot;" title="A &lt;title>"'))
    assert.ok(last.includes("[…page text cut off here]"))
    assert.ok(!last.includes("</page> injected"))
    assert.ok(last.endsWith("Summarize it"))
  })

  it("keeps only the newest history that fits", () => {
    const history = []
    for (let i = 0; i < 12; i++) history.unshift({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "w".repeat(900) })
    const messages = buildAirllmMessages({ message: "now", history, filesBlock: "", page: null }, 1000)
    const text = messages.map((m) => m.content).join("|")
    assert.ok(text.includes("turn 11"))
    assert.ok(!text.includes("turn 3 "))
    for (let i = 2; i < messages.length; i++) assert.notEqual(messages[i].role, messages[i - 1].role)
    assert.equal(messages[1].role, "user")
  })

  it("streams the reply as Devon SSE, sends the key server-to-server, and saves the reply", async () => {
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init })
      return sseResponse([
        chunk(""),
        ": keepalive\n\n",
        ": queued 1\n\n",
        chunk("Hello"),
        chunk(" from AirLLM."),
        ": trimmed 2\n\n",
        chunk(null, "stop"),
        "data: [DONE]\n\n",
      ])
    }
    const { value, saved } = input({ env: { DEVON_AIRLLM_BASE_URL: "https://airllm.example", DEVON_AIRLLM_API_KEY: "secret-key", DEVON_AIRLLM_MAX_TOKENS: "99", DEVON_AIRLLM_MODEL: "qwen" } })
    const response = await createAirllmChatResponse(value)
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /text\/event-stream/)
    const events = await readEvents(response)

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, "https://airllm.example/v1/chat/completions")
    assert.equal(requests[0].init.headers.Authorization, "Bearer secret-key")
    const body = JSON.parse(requests[0].init.body)
    assert.equal(body.stream, true)
    assert.equal(body.max_tokens, 99)
    assert.equal(body.model, "qwen")
    assert.equal(body.messages.at(-1).content, "What is this page about?")

    assert.deepEqual(events[0], { type: "tool_called", data: { tool: "airllm_prompt" } })
    assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => e.data.delta), ["Hello", " from AirLLM."])
    assert.deepEqual(events.filter((e) => e.type === "notice").map((e) => e.data.code), ["airllm_queued", "airllm_trimmed"])
    assert.deepEqual(events.at(-1), { type: "done", data: { stopped: false } })
    assert.deepEqual(saved, ["Hello from AirLLM."])
  })

  it("handles events split across network chunks and CRLF line endings", async () => {
    globalThis.fetch = async () => {
      const whole = chunk("Spl").replace(/\n/g, "\r\n") + chunk("it") + chunk(null, "length") + "data: [DONE]\n\n"
      const pieces = []
      for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7))
      return sseResponse(pieces)
    }
    const { value, saved } = input()
    const events = await readEvents(await createAirllmChatResponse(value))
    assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => e.data.delta), ["Spl", "it"])
    assert.ok(events.some((e) => e.type === "notice" && e.data.code === "airllm_length"))
    assert.equal(events.at(-1).type, "done")
    assert.deepEqual(saved, ["Split"])
  })

  it("maps the server's refusals to messages a visitor can act on", async () => {
    const cases = [
      [401, { error: { code: "unauthorized" } }, 503, "not_configured", /DEVON_AIRLLM_API_KEY/],
      [503, { error: { code: "model_loading" } }, 503, "airllm_loading", /still loading/],
      [503, { error: { code: "model_failed" } }, 503, "airllm_unavailable", /couldn't load/],
      [503, { error: { code: "busy" } }, 503, "airllm_busy", /one at a time/],
      [400, { error: { code: "context_length_exceeded" } }, 400, "bad_request", /too long/],
      [500, "oops", 502, "airllm_unavailable", /HTTP 500/],
    ]
    for (const [status, payload, wantStatus, wantError, wantMessage] of cases) {
      globalThis.fetch = async () => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status })
      const response = await createAirllmChatResponse(input().value)
      assert.equal(response.status, wantStatus, `HTTP ${status}`)
      const body = await response.json()
      assert.equal(body.error, wantError)
      assert.match(body.message, wantMessage)
      assert.ok(!body.message.includes("secret-key"))
    }
  })

  it("reports an unreachable server without leaking its address", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.5:8790")
    }
    const response = await createAirllmChatResponse(input({ env: { DEVON_AIRLLM_BASE_URL: "http://10.0.0.5:8790" } }).value)
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, "airllm_unavailable")
    assert.ok(!body.message.includes("10.0.0.5"))
  })

  it("passes on an error sent mid-stream and keeps any text already written", async () => {
    globalThis.fetch = async () =>
      sseResponse([chunk("Partial"), `data: ${JSON.stringify({ error: { code: "generation_failed", message: "CUDA out of memory" } })}\n\n`, "data: [DONE]\n\n"])
    const { value, saved } = input()
    const events = await readEvents(await createAirllmChatResponse(value))
    const last = events.at(-1)
    assert.equal(last.type, "error")
    assert.equal(last.data.message, "AirLLM couldn't finish that reply.")
    assert.deepEqual(saved, ["Partial"])
  })

  it("treats a stream that ends without [DONE] as an error", async () => {
    globalThis.fetch = async () => sseResponse([chunk("Half")])
    const { value, saved } = input()
    const events = await readEvents(await createAirllmChatResponse(value))
    assert.equal(events.at(-1).type, "error")
    assert.deepEqual(saved, ["Half"])
  })

  it("Stop aborts the upstream request and saves what was written so far", async () => {
    const stop = new AbortController()
    let upstreamSignal
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk("Before stop")))
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    const { value, saved } = input({ signal: stop.signal })
    const response = await createAirllmChatResponse(value)
    setTimeout(() => stop.abort(), 50)
    const events = await readEvents(response)
    assert.equal(upstreamSignal.aborted, true)
    assert.deepEqual(events.at(-1), { type: "done", data: { stopped: true } })
    assert.deepEqual(saved, ["Before stop"])
  })

  it("ends the reply cleanly at the deadline, keeping the text and freeing the server", async () => {
    let upstreamSignal
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk("Slow but")))
          init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    // The route's own deadline, then a shorter DEVON_AIRLLM_TIMEOUT_SECONDS winning over a long one
    for (const [timeoutMs, envSeconds] of [[60, undefined], [60_000, "1"]]) {
      const started = Date.now()
      const env = { DEVON_AIRLLM_BASE_URL: "https://airllm.example", ...(envSeconds ? { DEVON_AIRLLM_TIMEOUT_SECONDS: envSeconds } : {}) }
      const { value, saved } = input({ env, timeoutMs })
      const events = await readEvents(await createAirllmChatResponse(value))
      assert.ok(Date.now() - started < 3000, "the env setting should shorten the route's deadline")
      assert.equal(upstreamSignal.aborted, true)
      assert.ok(events.some((e) => e.type === "notice" && e.data.code === "airllm_timeout"))
      assert.deepEqual(events.at(-1), { type: "done", data: { stopped: false } })
      assert.deepEqual(saved, ["Slow but"])
    }
  })

  it("closing Devon's stream (the visitor left) closes the upstream connection", async () => {
    let upstreamSignal
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunk("hi"))) } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }
    const { value, saved } = input()
    const response = await createAirllmChatResponse(value)
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    assert.equal(upstreamSignal.aborted, true)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(saved, ["hi"]) // recorded as a stopped reply, not an error
  })
})
