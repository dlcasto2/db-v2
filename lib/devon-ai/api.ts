/**
 * Devon AI's backend calls (EdgeOne Makers agent + cloud functions).
 * Adapted from TencentEdgeOne/claude-agent-starter-node (MIT).
 *
 *   agents/ai-chat                          → POST /ai-chat                (SSE)
 *   agents/ai-stop                          → POST /ai-stop
 *   cloud-functions/ai-history              → POST /ai-history
 *   cloud-functions/ai-conversations        → POST /ai-conversations
 *   cloud-functions/ai-delete-conversation  → POST /ai-delete-conversation
 *   cloud-functions/ai-page-result          → POST /ai-page-result   (page tool results)
 *   cloud-functions/ai-session              → POST /ai-session       (session state)
 *   cloud-functions/ai-feedback             → POST /ai-feedback     (thumbs up/down on a reply)
 */

import type {
  BrowserSession,
  FeedbackReasonCode,
  ImageSsePayload,
  ListConversationsResponse,
  Message,
  PageContext,
  Quota,
  SessionState,
  UploadedFile,
} from "@/lib/devon-ai/types"
import type { PageActionOutcome, PageActionRequest } from "@/lib/devon-ai/page-executor"
import { aiUrl } from "@/lib/devon-ai/api-base"

export const AI_API = {
  chat: "/ai-chat",
  stop: "/ai-stop",
  history: "/ai-history",
  conversations: "/ai-conversations",
  deleteConversation: "/ai-delete-conversation",
  pageResult: "/ai-page-result",
  session: "/ai-session",
  filesystem: "/ai-filesystem",
  feedback: "/ai-feedback",
} as const

/** Why a message couldn't be sent */
export type ChatFailure =
  | { kind: "rate_limited"; quota: Quota }
  | { kind: "not_configured"; message: string }
  /** The AI routes aren't on this deployment (404/405, or the static site answered) */
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }

export interface StreamCallbacks {
  onQuota?: (quota: Quota) => void
  onTextDelta: (delta: string) => void
  onToolCalled: (tool: string) => void
  onSkillLoaded?: (name: string) => void
  onImage: (payload: ImageSsePayload) => void
  onNotice?: (code: string, message: string) => void
  onSession?: (session: SessionState) => void
  onPageAction?: (request: PageActionRequest) => void
  onDone: (stopped: boolean) => void
  onFail: (failure: ChatFailure) => void
}

async function chatRequestBody(args: {
  message: string
  userId: string
  userMsgId: string
  botMsgId: string
  page?: PageContext
  browser?: BrowserSession
  files?: UploadedFile[]
}): Promise<BodyInit> {
  const body = {
    message: args.message,
    userId: args.userId,
    userMsgId: args.userMsgId,
    botMsgId: args.botMsgId,
    ...(args.page ? { page: args.page } : {}),
    ...(args.browser ? { browser: args.browser } : {}),
  }
  if (!args.files?.length || args.files.reduce((sum, file) => sum + file.text.length, 0) <= 500_000) {
    return JSON.stringify({ ...body, ...(args.files?.length ? { files: args.files } : {}) })
  }
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser can't prepare large file uploads. Please use a current version of Chrome, Edge, or Firefox.")
  }

  const form = new FormData()
  let transportBytes = 0
  const fileParts: {
    name: string
    path: string
    mimeType: string
    size: number
    field: string
    encoding: "gzip" | "identity"
  }[] = []
  for (const [index, file] of args.files.entries()) {
    const raw = new Blob([file.text], { type: "text/plain;charset=utf-8" })
    const compressed = await new Response(raw.stream().pipeThrough(new CompressionStream("gzip"))).blob()
    const useCompression = compressed.size < raw.size
    const field = `file_${index}`
    const upload = useCompression ? compressed : raw
    transportBytes += upload.size
    if (transportBytes > 4_000_000) {
      throw new Error("This attachment is still too large to send safely after compression. Split it into smaller files or upload less text.")
    }
    form.append(field, upload, `${field}.bin`)
    fileParts.push({
      name: file.name,
      path: file.path,
      mimeType: file.mimeType,
      size: file.size,
      field,
      encoding: useCompression ? "gzip" : "identity",
    })
  }
  form.append("payload", JSON.stringify({ ...body, fileParts }))
  return form
}

/** Reads a non-stream response from /ai-chat into a failure */
async function failureFrom(res: Response): Promise<ChatFailure> {
  const type = res.headers.get("content-type") || ""
  const body = type.includes("json") ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null
  if (res.status === 429 && body?.error === "rate_limited") {
    return {
      kind: "rate_limited",
      quota: { used: Number(body.used) || 0, limit: Number(body.limit) || 0, resetAt: Number(body.resetAt) || 0 },
    }
  }
  if (res.status === 503 && body?.error === "not_configured") {
    return { kind: "not_configured", message: String(body.message || "Devon AI isn't set up on this site yet.") }
  }
  if (res.status === 404 || res.status === 405 || (!body && type.includes("html"))) {
    return { kind: "unavailable", message: "Devon AI isn't deployed on this site." }
  }
  if (res.status === 429) return { kind: "error", message: "Devon AI is busy right now. Try again in a moment." }
  const message = typeof body?.message === "string" ? body.message : `Devon AI returned an error (HTTP ${res.status}).`
  return { kind: "error", message }
}

/**
 * POST /ai-chat and read its SSE stream. Returns an AbortController; aborting
 * stops reading (pair it with stopAgent so the server stops too).
 */
export function sendMessageStream(
  args: {
    message: string
    conversationId: string
    userId: string
    userMsgId: string
    botMsgId: string
    page?: PageContext
    browser?: BrowserSession
    files?: UploadedFile[]
  },
  cb: StreamCallbacks,
): AbortController {
  const ctrl = new AbortController()

  ;(async () => {
    let doneReceived = false
    let failed = false
    try {
      const body = await chatRequestBody(args)
      const res = await fetch(aiUrl(AI_API.chat), {
        method: "POST",
        headers: {
          ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          "makers-conversation-id": args.conversationId,
        },
        body,
        signal: ctrl.signal,
      })

      if (!res.ok || !(res.headers.get("content-type") || "").includes("text/event-stream")) {
        failed = true
        cb.onFail(res.ok ? { kind: "unavailable", message: "Devon AI isn't deployed on this site." } : await failureFrom(res))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        failed = true
        cb.onFail({ kind: "error", message: "This browser can't read streamed replies." })
        return
      }

      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split("\n\n")
        buffer = parts.pop() || ""
        for (const part of parts) {
          if (!part.trim()) continue
          const result = dispatchSseChunk(part, cb)
          if (result === "done") doneReceived = true
          if (result === "error") failed = true
        }
      }
      if (!doneReceived && !failed) cb.onDone(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      cb.onFail({
        kind: "error",
        message: err instanceof Error ? err.message : "Lost the connection to Devon AI. Check your network and try again.",
      })
    }
  })()

  return ctrl
}

function dispatchSseChunk(part: string, cb: StreamCallbacks): "done" | "error" | void {
  let eventType = ""
  let data = ""
  for (const line of part.split("\n")) {
    if (line.startsWith("event: ")) eventType = line.slice(7).trim()
    else if (line.startsWith("data: ")) data += line.slice(6)
  }
  if (!eventType || !data) return
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  switch (eventType) {
    case "quota":
      cb.onQuota?.({ used: Number(parsed.used) || 0, limit: Number(parsed.limit) || 0, resetAt: Number(parsed.resetAt) || 0 })
      break
    case "text_delta":
      if (typeof parsed.delta === "string") cb.onTextDelta(parsed.delta)
      break
    case "tool_called":
      if (typeof parsed.tool === "string") cb.onToolCalled(parsed.tool)
      break
    case "skill_loaded":
      if (typeof parsed.name === "string") cb.onSkillLoaded?.(parsed.name)
      break
    case "image":
      if (typeof parsed.base64 === "string") {
        cb.onImage({
          imageId: typeof parsed.imageId === "string" ? parsed.imageId : crypto.randomUUID(),
          base64: parsed.base64,
          mimeType: typeof parsed.mimeType === "string" ? parsed.mimeType : "image/png",
          size: Number(parsed.size) || 0,
        })
      }
      break
    case "session":
      if (parsed.session && typeof parsed.session === "object") cb.onSession?.(parsed.session as SessionState)
      break
    case "page_action":
      if (typeof parsed.callId === "string" && typeof parsed.tool === "string") {
        cb.onPageAction?.({
          callId: parsed.callId,
          tool: parsed.tool,
          args: parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {},
        })
      }
      break
    case "notice":
      cb.onNotice?.(String(parsed.code || ""), String(parsed.message || ""))
      break
    case "error":
      cb.onFail({ kind: "error", message: String(parsed.message || "Devon AI hit an error.") })
      return "error"
    case "done":
      cb.onDone(Boolean(parsed.stopped))
      return "done"
  }
}

/**
 * Ask the server to stop the running reply; the target goes in the body.
 * EdgeOne's docs disagree on whether /stop may carry makers-conversation-id
 * (the agents guide says never, since it can pin the request to the busy chat
 * instance; the quick start says every agent call needs it and answers 400
 * without). So try without the header first, and add it only on a 400.
 */
export async function stopAgent(conversationId: string): Promise<boolean> {
  const post = (withHeader: boolean) =>
    fetch(aiUrl(AI_API.stop), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(withHeader ? { "makers-conversation-id": conversationId } : {}),
      },
      body: JSON.stringify({ conversation_id: conversationId }),
    })
  try {
    let res = await post(false)
    if (res.status === 400) res = await post(true)
    return res.ok
  } catch {
    return false
  }
}

/** Messages of one conversation, for showing it again after a reload */
export async function fetchConversationHistory(conversationId: string, userId: string): Promise<Message[]> {
  try {
    const res = await fetch(aiUrl(AI_API.history), {
      method: "POST",
      headers: { "Content-Type": "application/json", "makers-conversation-id": conversationId },
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    })
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return []
    const data = (await res.json().catch(() => null)) as { messages?: Message[] } | null
    return Array.isArray(data?.messages) ? data.messages : []
  } catch {
    return []
  }
}

export async function listConversations(userId: string, after?: string, limit = 20): Promise<ListConversationsResponse> {
  const empty: ListConversationsResponse = { conversations: [] }
  try {
    const res = await fetch(aiUrl(AI_API.conversations), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, limit, order: "desc", after }),
    })
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return empty
    const data = (await res.json().catch(() => null)) as ListConversationsResponse | null
    if (!data || !Array.isArray(data.conversations)) return empty
    return { conversations: data.conversations, nextCursor: data.nextCursor, previousCursor: data.previousCursor }
  } catch {
    return empty
  }
}

/** Permanently delete a conversation (the caller has already confirmed) */
export async function deleteConversation(conversationId: string, userId: string): Promise<boolean> {
  try {
    const res = await fetch(aiUrl(AI_API.deleteConversation), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Hand a page action's result back to the waiting agent (retries a few times) */
export async function postPageResult(conversationId: string, callId: string, outcome: PageActionOutcome): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(aiUrl(AI_API.pageResult), {
        method: "POST",
        headers: { "Content-Type": "application/json", "makers-conversation-id": conversationId },
        body: JSON.stringify({
          conversation_id: conversationId,
          call_id: callId,
          ok: outcome.ok,
          text: outcome.text,
          ...(outcome.image ? { image: outcome.image } : {}),
          ...(outcome.tab ? { tab: outcome.tab } : {}),
        }),
      })
      if (res.ok) return true
      if (res.status < 500) return false
    } catch {
      // network blip: try again
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return false
}

/** A chat's session state from the server (null if none, or the runtime can't say) */
export async function fetchSession(conversationId: string): Promise<{ session: SessionState | null; available: boolean }> {
  try {
    const res = await fetch(aiUrl(AI_API.session), {
      method: "POST",
      headers: { "Content-Type": "application/json", "makers-conversation-id": conversationId },
      body: JSON.stringify({ action: "get" }),
    })
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return { session: null, available: false }
    const data = (await res.json().catch(() => null)) as { session?: SessionState | null; available?: boolean } | null
    return { session: data?.session ?? null, available: Boolean(data?.available) }
  } catch {
    return { session: null, available: false }
  }
}

/**
 * Record a thumbs up/down on a reply. Best-effort, fire-and-forget: a visitor
 * never needs to wait on this and it never blocks the chat. Note: deliberately
 * doesn't send the page or the conversation — see "Devon AI" → "Feedback" in
 * README.md for exactly what's logged and why.
 */
export async function postFeedback(input: {
  conversationId: string
  messageId: string
  rating: "up" | "down"
  reason?: FeedbackReasonCode
  note?: string
  taskType: string
}): Promise<boolean> {
  try {
    const res = await fetch(aiUrl(AI_API.feedback), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: input.conversationId,
        message_id: input.messageId,
        rating: input.rating,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.note ? { note: input.note } : {}),
        task_type: input.taskType,
      }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function clearSessionApi(conversationId: string): Promise<boolean> {
  try {
    const res = await fetch(aiUrl(AI_API.session), {
      method: "POST",
      headers: { "Content-Type": "application/json", "makers-conversation-id": conversationId },
      body: JSON.stringify({ action: "clear" }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function fileSystemRequest<T = Record<string, unknown>>(
  conversationId: string,
  action: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(aiUrl(AI_API.filesystem), {
    method: "POST",
    headers: { "Content-Type": "application/json", "makers-conversation-id": conversationId },
    body: JSON.stringify({ ...input, action }),
  })
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok && res.status !== 409) {
    const message = data && typeof data.error === "string" ? data.error : `Filesystem request failed (HTTP ${res.status}).`
    throw new Error(message)
  }
  if (!data) throw new Error("The filesystem returned an invalid response.")
  return data
}
