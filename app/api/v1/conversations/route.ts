/**
 * Devon AI Public API — POST /api/v1/conversations
 *
 * List conversations for a user, newest first.
 *
 * Request body:
 *   user_id    string          (required)
 *   limit      number          1–100, default 20
 *   order      "asc" | "desc"  default "desc"
 *   after      string          cursor from a previous response
 *
 * Response:
 *   { conversations: [{ id, title, created_at, last_message_at }], next_cursor }
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("api-v1-conversations")
const TITLE_MAX = 60

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  })
}

function titleFrom(firstUserMessage: string | undefined): string {
  const s = (firstUserMessage ?? "").replace(/\s+/g, " ").trim()
  if (!s) return "New chat"
  return s.length <= TITLE_MAX ? s : `${s.slice(0, TITLE_MAX)}\u2026`
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ error: { code: "INVALID_JSON", message: "Body must be valid JSON." } }, 400)
  }

  const userId = typeof body.user_id === "string" ? body.user_id.trim() : ""
  if (!userId) return json({ error: { code: "MISSING_USER_ID", message: "'user_id' is required." } }, 400)

  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100)
  const order = body.order === "asc" ? "asc" : "desc"
  const after = typeof body.after === "string" && body.after.trim() ? body.after.trim() : undefined

  try {
    const store = createAiStore("")
    const result = await store.listConversations({ userId, limit, order, after })
    const conversations = result.items
      .filter((c) => !/^(d[qft]|acct)-/.test(c.id))
      .map((c) => ({
        id: c.id,
        title: titleFrom(c.firstUserMessage),
        created_at: c.createdAt ?? null,
        last_message_at: c.lastMessageAt ?? null,
      }))
    return json({ conversations, next_cursor: result.nextCursor ?? null })
  } catch (e) {
    logger.error("listConversations failed:", e)
    return json({ error: { code: "STORE_ERROR", message: "Failed to fetch conversations." } }, 500)
  }
}
