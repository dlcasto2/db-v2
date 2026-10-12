/**
 * Devon AI's backend calls (EdgeOne Makers agent + cloud functions).
 * Adapted from TencentEdgeOne/claude-agent-starter-node (MIT).
 *
 *   agents/ai-chat                          → POST /ai-chat                (SSE)
 *   agents/ai-stop                          → POST /ai-stop
 *   cloud-functions/ai-history              → POST /ai-history
 *   cloud-functions/ai-conversations        → POST /ai-conversations
 *   cloud-functions/ai-delete-conversation  → POST /ai-delete-conversation
 */

import type { ImageSsePayload, ListConversationsResponse, Message, PageContext, Quota } from "@/lib/devon-ai/types"

export const AI_API = {
  chat: "/ai-chat",
  stop: "/ai-stop",
  history: "/ai-history",
  conversations: "/ai-conversations",
  deleteConversation: "/ai-delete-conversation",
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
  onDone: (stopped: boolean) => void
  onFail: (failure: ChatFailure) => void
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
  },
  cb: StreamCallbacks,
): AbortController {
  const ctrl = new AbortController()

  ;(async () => {
    let doneReceived = false
    let failed = false
    try {
      const res = await fetch(AI_API.chat, {
        method: "POST",
        headers: { "Content-Type": "application/json", "makers-conversation-id": args.conversationId },
        body: JSON.stringify({
          message: args.message,
          userId: args.userId,
          userMsgId: args.userMsgId,
          botMsgId: args.botMsgId,
          ...(args.page ? { page: args.page } : {}),
        }),
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
      cb.onFail({ kind: "error", message: "Lost the connection to Devon AI. Check your network and try again." })
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
    fetch(AI_API.stop, {
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
    const res = await fetch(AI_API.history, {
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
    const res = await fetch(AI_API.conversations, {
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
    const res = await fetch(AI_API.deleteConversation, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId }),
    })
    return res.ok
  } catch {
    return false
  }
}
