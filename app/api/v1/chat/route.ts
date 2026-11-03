/**
 * Devon AI Public API — POST /api/v1/chat
 *
 * A standalone chat endpoint that talks to Devon AI directly.
 * No API key required. Persistent conversations via conversation_id.
 *
 * Request body (JSON):
 *   message          string   The message to send                   (required)
 *   conversation_id  string   Resume an existing conversation       (optional, UUID)
 *   user_id          string   Stable caller ID (for history)        (optional)
 *   stream           boolean  true = SSE stream, false = buffered   (default false)
 *
 * Buffered response:
 *   { conversation_id, reply, stopped, usage: { turns } }
 *
 * Streaming response (SSE):
 *   event: text_delta  data: { delta: string }
 *   event: tool_called data: { tool: string }
 *   event: done        data: { stopped: boolean }
 *   event: error       data: { message: string }
 *   event: ping        data: {}
 *
 *   The conversation_id is sent in the X-Devon-Conversation-Id response header.
 *
 * Errors:
 *   { error: { code, message } }
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { buildSdkEnv, modelConfigured, resolveModelName } from "@/agents/_model"
import { createLogger } from "@/agents/_logger"
import { takeQuota } from "@/agents/_quota"
import { loadSession, readBrowserSession, sessionBlock } from "@/agents/_session"
import { DEVON_SERVER, DEVON_TOOL_NAMES, type StreamChannel, createDevonTools } from "@/agents/ai-chat/_devon-tools"
import { createChatStream } from "@/agents/ai-chat/_stream"
import { createAiStore, type StoredMessage } from "@/lib/devon-ai/server/store"
import { redis } from "@/lib/devon-ai/server/kv"
import { SANDBOX_SERVER, SANDBOX_TOOL_NAMES, createSandboxTools, sandboxConfigured } from "@/lib/devon-ai/server/sandbox-tools"

export const runtime = "nodejs"
export const maxDuration = 300

const logger = createLogger("api-v1-chat")

const MAX_MESSAGE_CHARS = 8000
const MAX_HISTORY_MESSAGES = 16
const MAX_HISTORY_CHARS = 4000
const STOP_POLL_MS = 1000

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  })
}

function buildApiSystemPrompt(sandboxOn: boolean): string {
  const sandboxSection = sandboxOn
    ? "You have access to a sandbox (isolated environment) where you can run shell commands, read/write files, and execute code.\n\n"
    : "You have no code execution or filesystem tools.\n\n"

  return (
    "You are Devon AI, the assistant built into Devon, a web browser. " +
    "You are being called through the Devon AI public API. " +
    "Be helpful, clear, and concise. Match the user's level and tone.\n\n" +
    sandboxSection +
    "Rules:\n" +
    "1. Use a tool only when it's needed to answer concretely. Most questions need no tools.\n" +
    "2. Call tools one at a time and wait for each result.\n" +
    "3. Never invent or paraphrase tool results. If a tool fails, say so briefly.\n" +
    "4. No destructive file or shell operations unless explicitly asked.\n" +
    "5. Use Markdown for lists, tables and code."
  )
}

function messageText(content: unknown): string {
  return typeof content === "string" ? content : ""
}

function historyBlock(messages: StoredMessage[]): string {
  const turns = messages
    .slice()
    .reverse()
    .map((m) => ({ who: m.role === "assistant" ? "Devon AI" : "User", text: messageText(m.content).trim() }))
    .filter((t) => t.text)
  if (!turns.length) return ""
  let text = turns.map((t) => `${t.who}: ${t.text}`).join("\n")
  if (text.length > MAX_HISTORY_CHARS) text = `\u2026${text.slice(text.length - MAX_HISTORY_CHARS)}`
  return `<earlier_turns>\n${text}\n</earlier_turns>`
}

function stopKey(conversationId: string): string {
  return `devon:stop:${conversationId}`
}

function clientIp(req: Request): string {
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim()
  return forwarded || req.headers.get("x-real-ip") || ""
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON." } }, 400)
  }

  const message = typeof body.message === "string" ? body.message.trim() : ""
  if (!message) {
    return json({ error: { code: "MISSING_MESSAGE", message: "'message' is required." } }, 400)
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return json({ error: { code: "MESSAGE_TOO_LONG", message: `Messages can be up to ${MAX_MESSAGE_CHARS} characters.` } }, 400)
  }

  const rawUserId = typeof body.user_id === "string" ? body.user_id : ""
  const userId = /^[A-Za-z0-9_-]{1,64}$/.test(rawUserId.trim()) ? rawUserId.trim() : ""

  const conversationId =
    typeof body.conversation_id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.conversation_id.trim())
      ? body.conversation_id.trim()
      : crypto.randomUUID()

  if (/^(d[qfst]|acct)-/.test(conversationId)) {
    return json({ error: { code: "INVALID_CONVERSATION_ID", message: "That conversation_id is reserved." } }, 400)
  }

  const wantsStream = body.stream === true
  const env = process.env

  if (!modelConfigured(env)) {
    return json({
      error: {
        code: "NOT_CONFIGURED",
        message: "Devon AI isn't configured on this server. Set ANTHROPIC_API_KEY in your environment.",
      },
    }, 503)
  }

  const store = createAiStore(conversationId)
  const ip = clientIp(request)
  const quota = await takeQuota(
    store,
    env,
    { visitor: userId || `ip:${ip || "unknown"}`, network: ip || undefined },
    logger.error,
  )

  if (!quota.ok) {
    return json({
      error: {
        code: "RATE_LIMITED",
        message: `Daily quota exceeded. Resets at ${new Date(quota.resetAt).toISOString()}.`,
        used: quota.used,
        limit: quota.limit,
        reset_at: quota.resetAt,
      },
    }, 429)
  }

  const history = await store.getMessages({ conversationId, limit: MAX_HISTORY_MESSAGES, order: "desc" }).catch(() => [])
  const sessionRef = { current: await loadSession(store, conversationId, logger.error) }

  const userMsgId = crypto.randomUUID()
  const botMsgId = crypto.randomUUID()
  try {
    await store.appendMessage({
      conversationId,
      role: "user",
      content: message,
      ...(userId ? { userId } : {}),
      messageId: userMsgId,
    })
  } catch (e) {
    logger.error("[store] failed to save user message:", e)
  }

  const historyText = historyBlock(history)
  const sessionText = sessionBlock(sessionRef.current, readBrowserSession(null))
  const prompt = [sessionText, historyText, message].filter(Boolean).join("\n\n")

  const abortController = new AbortController()
  if (request.signal.aborted) abortController.abort()
  else request.signal.addEventListener("abort", () => abortController.abort(), { once: true })

  const r = redis()
  const stopPoll = r
    ? setInterval(async () => {
        if (abortController.signal.aborted) { clearInterval(stopPoll); return }
        try {
          if (await r.get(stopKey(conversationId))) { abortController.abort(); clearInterval(stopPoll) }
        } catch { /* transient — wait for next poll */ }
      }, STOP_POLL_MS)
    : undefined
  if (stopPoll) setTimeout(() => clearInterval(stopPoll), maxDuration * 1000)

  const channel: StreamChannel = { send: () => {} }
  const sandboxOn = sandboxConfigured(env)

  const devonServer = createSdkMcpServer({
    name: DEVON_SERVER,
    tools: createDevonTools({
      channel,
      store,
      conversationId,
      signal: request.signal,
      session: sessionRef,
      logError: logger.error,
    }),
    alwaysLoad: true,
    timeout: 180_000,
  })

  const sandboxServer = sandboxOn
    ? createSdkMcpServer({
        name: SANDBOX_SERVER,
        tools: createSandboxTools({
          store,
          env,
          visitor: userId || `ip:${ip || "unknown"}`,
          logError: logger.error,
        }),
        alwaysLoad: true,
        timeout: 90_000,
      })
    : undefined

  const options: Record<string, unknown> = {
    model: resolveModelName(env),
    systemPrompt: buildApiSystemPrompt(sandboxOn),
    cwd: process.cwd(),
    tools: [],
    allowedTools: sandboxOn ? [...DEVON_TOOL_NAMES, ...SANDBOX_TOOL_NAMES] : DEVON_TOOL_NAMES,
    permissionMode: "bypassPermissions",
    maxTurns: 24,
    env: buildSdkEnv(env),
    stderr: (line: string) => logger.error("[claude-cli stderr]", line),
    mcpServers: sandboxOn
      ? { [DEVON_SERVER]: devonServer, [SANDBOX_SERVER]: sandboxServer }
      : { [DEVON_SERVER]: devonServer },
  }

  const sseStream = createChatStream({
    prompt,
    options,
    signal: abortController.signal,
    logger,
    conversationId,
    store,
    botMsgId,
    userId: userId || undefined,
    quota,
    session: sessionRef.current,
    channel,
  })

  // --- Streaming path ---
  if (wantsStream) {
    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Devon-Conversation-Id": conversationId,
      },
    })
  }

  // --- Buffered path: drain the SSE stream and return JSON ---
  const reader = sseStream.getReader()
  const decoder = new TextDecoder()
  const replyParts: string[] = []
  let turns = 0
  let stopped = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const lines = chunk.split("\n")
      let evtName = ""
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith("event:")) { evtName = t.slice(6).trim(); continue }
        if (t.startsWith("data:")) {
          const raw = t.slice(5).trim()
          if (!raw) continue
          try {
            const data = JSON.parse(raw) as Record<string, unknown>
            if (evtName === "text_delta" && typeof data.delta === "string") replyParts.push(data.delta)
            if (evtName === "done") { stopped = Boolean(data.stopped); turns++ }
            if (evtName === "error") {
              return json({ error: { code: "AI_ERROR", message: data.message as string } }, 500)
            }
          } catch { /* skip malformed lines */ }
          evtName = ""
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  return json({
    conversation_id: conversationId,
    reply: replyParts.join(""),
    stopped,
    usage: { turns },
  })
}
