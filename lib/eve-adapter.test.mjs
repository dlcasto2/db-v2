import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { createEveChatResponse, eveConfigured } from "../agents/ai-chat/_eve.ts"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("Devon AI Eve adapter", () => {
  it("requires both the Eve origin and a server-side JWT secret", () => {
    assert.equal(eveConfigured({}), false)
    assert.equal(eveConfigured({ DEVON_EVE_BASE_URL: "https://eve.example" }), false)
    assert.equal(eveConfigured({ DEVON_EVE_JWT_SECRET: "x".repeat(40) }), false)
    assert.equal(eveConfigured({ DEVON_EVE_BASE_URL: "https://eve.example", DEVON_EVE_JWT_SECRET: "x".repeat(40) }), true)
  })

  it("rejects a weak or malformed Eve configuration before making a network request", async () => {
    let fetched = false
    globalThis.fetch = async () => {
      fetched = true
      throw new Error("fetch should not be called")
    }
    const input = {
      env: { DEVON_EVE_BASE_URL: "https://eve.example/path", DEVON_EVE_JWT_SECRET: "x".repeat(40) },
      message: "hello",
      conversationId: "conversation_1",
      userId: "visitor_123",
      page: null,
      history: [],
      sessionBlock: "",
      filesBlock: "",
      signal: new AbortController().signal,
      onSessionCreated: async () => undefined,
      onCursorUpdated: async () => undefined,
      onAssistantMessage: async () => undefined,
    }
    const response = await createEveChatResponse(input)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error, "not_configured")
    assert.equal(fetched, false)
  })

  it("creates an Eve session, converts NDJSON deltas to Devon SSE and saves the reply", async () => {
    const requests = []
    const saved = { bindings: [], replies: [] }
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      requests.push({ url, method: init.method || "GET", body: init.body })
      if (url.endsWith("/eve/v1/session")) {
        return new Response(JSON.stringify({ sessionId: "session_test_1" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.includes("/stream?")) {
        const lines = [
          { progress: { type: "content.delta", data: { partId: "part_0", delta: "Hello from Eve." } } },
          { at: new Date().toISOString(), facts: [
            { type: "content.completed", data: { partId: "part_0", kind: "text", phase: "reply", value: "Hello from Eve." } },
            { type: "turn.settled", data: { outcome: "completed", reply: ["part_0"] } },
          ] },
        ].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        return new Response(lines, {
          headers: { "content-type": "application/x-ndjson", "x-eve-stream-version": "27" },
        })
      }
      throw new Error(`Unexpected Eve request: ${url}`)
    }

    const response = await createEveChatResponse({
      env: { DEVON_EVE_BASE_URL: "https://eve.example", DEVON_EVE_JWT_SECRET: "s".repeat(48) },
      message: "Say hello",
      conversationId: "conversation_1",
      userId: "visitor_123",
      page: null,
      history: [],
      sessionBlock: "",
      filesBlock: "",
      signal: new AbortController().signal,
      onSessionCreated: async (binding) => saved.bindings.push(binding),
      onCursorUpdated: async (binding) => saved.bindings.push(binding),
      onAssistantMessage: async (reply) => saved.replies.push(reply),
    })

    const sse = await response.text()
    assert.equal(response.status, 200)
    assert.match(sse, /event: text_delta/)
    assert.match(sse, /Hello from Eve\./)
    assert.match(sse, /event: done/)
    assert.equal(saved.replies[0], "Hello from Eve.")
    assert.equal(saved.bindings[0].sessionId, "session_test_1")
    assert.equal(saved.bindings.at(-1).cursor, 2)
    assert.equal(requests.length, 2)
    assert.match(requests[1].url, /startIndex=0/)
    assert.match(requests[0].body, /Say hello/)
  })

  it("continues the saved session from its cursor without resending the old transcript", async () => {
    const requests = []
    const saved = []
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input)
      requests.push({ url, method: init.method || "GET", body: init.body })
      if (url.endsWith("/session/session_test_2")) {
        return new Response(JSON.stringify({ deliveryId: "delivery_2" }), { status: 202 })
      }
      if (url.includes("/stream?")) {
        const lines = [{
          facts: [
            { type: "content.completed", data: { partId: "part_2", kind: "text", phase: "reply", value: "Continuing." } },
            { type: "turn.settled", data: { outcome: "completed", reply: ["part_2"] } },
          ],
        }].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
        return new Response(lines, { headers: { "x-eve-stream-version": "27" } })
      }
      throw new Error(`Unexpected Eve request: ${url}`)
    }

    const response = await createEveChatResponse({
      env: { DEVON_EVE_BASE_URL: "https://eve.example", DEVON_EVE_JWT_SECRET: "s".repeat(48) },
      message: "Continue this task",
      conversationId: "conversation_1",
      userId: "visitor_123",
      page: null,
      history: [{ role: "assistant", content: "Old Claude transcript" }],
      sessionBlock: "<devon_session>Current session</devon_session>",
      filesBlock: "",
      existingBinding: { sessionId: "session_test_2", userId: "visitor_123", cursor: 12 },
      signal: new AbortController().signal,
      onSessionCreated: async () => assert.fail("an existing Eve session should be reused"),
      onCursorUpdated: async (binding) => saved.push(binding),
      onAssistantMessage: async () => undefined,
    })

    const sse = await response.text()
    assert.equal(response.status, 200)
    assert.match(sse, /event: done/)
    assert.equal(requests.length, 2)
    assert.match(requests[0].url, /session\/session_test_2$/)
    assert.doesNotMatch(String(requests[0].body), /Old Claude transcript/)
    assert.match(String(requests[0].body), /Current session/)
    assert.match(requests[1].url, /startIndex=12/)
    assert.equal(saved.at(-1).cursor, 13)
  })
})
