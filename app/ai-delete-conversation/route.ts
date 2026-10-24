/**
 * Devon AI delete conversation — Vercel-native route, POST /ai-delete-conversation.
 *
 * Vercel-native equivalent of cloud-functions/ai-delete-conversation/index.ts,
 * against lib/devon-ai/server/store.ts's deleteConversation. Same request/
 * response shape as the EdgeOne version, so lib/devon-ai/api.ts needs no changes.
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("ai-delete-conversation")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const conversationId = (typeof body.conversation_id === "string" ? body.conversation_id : typeof body.conversationId === "string" ? body.conversationId : "").trim()
  const userId = (typeof body.user_id === "string" ? body.user_id : typeof body.userId === "string" ? body.userId : "").trim()

  if (!conversationId || /^(d[qft]|acct)-/.test(conversationId)) {
    logger.error("Missing conversationId")
    return jsonResponse({ status: "error", message: "conversation_id is required" }, 400)
  }

  try {
    const store = createAiStore(conversationId)
    await store.deleteConversation({ conversationId, ...(userId ? { userId } : {}) })
    return jsonResponse({ status: "ok", conversation_id: conversationId })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.error("failed to delete conversation:", e)
    return jsonResponse({ status: "error", conversation_id: conversationId, message }, 500)
  }
}
