/**
 * Devon AI session state — EdgeOne Makers Node Function
 * =====================================================
 *
 * cloud-functions/ai-session/index.ts maps to **POST /ai-session**.
 *
 * Reads or clears one chat's session state (task, steps, notes, pages used),
 * which the agent keeps in the conversation-scoped store (agents/_session.ts).
 * Send the chat's ID in the `makers-conversation-id` header, which binds the
 * store to that conversation; body { action?: "get" | "clear" }.
 * Answers { session: <state or null>, available: boolean }.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"

const logger = createLogger("ai-session")

const SESSION_KEY = "devon_session"
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" } as const

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await context.request!.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    // empty body
  }
  const conversationId = context.agent?.conversation_id || ""
  if (!conversationId || /^d[qt]-/.test(conversationId)) {
    return jsonResponse({ status: "error", message: "Send the chat ID in the makers-conversation-id header" }, 400)
  }
  const store = context.agent!.store
  try {
    if (body.action === "clear") {
      await store.state.delete(SESSION_KEY)
      return jsonResponse({ session: null, available: true })
    }
    const session = await store.state.get(SESSION_KEY)
    return jsonResponse({ session: session ?? null, available: true })
  } catch (e) {
    // Older runtimes without conversation-bound state: the browser keeps its own copy
    logger.error("store.state unavailable:", e)
    return jsonResponse({ session: null, available: false })
  }
}
