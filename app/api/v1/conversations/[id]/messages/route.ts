/**
 * Devon AI Public API — GET /api/v1/conversations/:id/messages
 *
 * Fetch the message history for a conversation.
 *
 * Query params:
 *   limit   number          1–100, default 20
 *   order   "asc" | "desc"  default "asc" (chronological)
 *
 * Response:
 *   { conversation_id, messages: [{ role, content, created_at }] }
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("api-v1-messages")

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: conversationId } = await params
  if (!conversationId) {
    return json({ error: { code: "MISSING_ID", message: "Conversation ID is required." } }, 400)
  }

  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100)
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc"

  try {
    const store = createAiStore(conversationId)
    const messages = await store.getMessages({ conversationId, limit, order })
    return json({
      conversation_id: conversationId,
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        created_at: m.createdAt,
      })),
    })
  } catch (e) {
    logger.error("getMessages failed:", e)
    return json({ error: { code: "STORE_ERROR", message: "Failed to fetch messages." } }, 500)
  }
}
