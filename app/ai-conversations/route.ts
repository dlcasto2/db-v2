/**
 * Devon AI conversation list — Vercel-native route, POST /ai-conversations.
 *
 * Vercel-native equivalent of cloud-functions/ai-conversations/index.ts,
 * against lib/devon-ai/server/store.ts's listConversations (a Redis sorted
 * set per user, see store.ts). Same request/response shape as the EdgeOne
 * version, so lib/devon-ai/api.ts needs no changes — including requiring
 * user_id, and dropping dq-/dt-/acct- pseudo-conversations from the result
 * (store.ts's listConversations never puts those in a user's index in the
 * first place, since they're never appended with a userId, but the filter
 * is kept here too in case that ever changes).
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("ai-conversations")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }
const TITLE_SNIPPET_MAX = 40

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function titleFrom(firstUserMessage: string | undefined): string {
  const cleaned = (firstUserMessage ?? "").replace(/\s+/g, " ").trim()
  if (!cleaned) return "New chat"
  return cleaned.length <= TITLE_SNIPPET_MAX ? cleaned : `${cleaned.slice(0, TITLE_SNIPPET_MAX)}...`
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const userId = (typeof body.user_id === "string" ? body.user_id : typeof body.userId === "string" ? body.userId : "").trim()
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 100)
  const order = body.order === "asc" ? "asc" : "desc"
  const after = typeof body.after === "string" && body.after.trim() ? body.after.trim() : undefined

  if (!userId) {
    logger.error("Missing userId")
    return jsonResponse({ status: "error", message: "user_id is required" }, 400)
  }

  try {
    const store = createAiStore("")
    const result = await store.listConversations({ userId, limit, order, after })
    const conversations = result.items
      .filter((c) => !/^(d[qt]|acct)-/.test(c.id))
      .map((c) => ({
        id: c.id,
        title: titleFrom(c.firstUserMessage),
        lastMessageAt: c.lastMessageAt,
        createdAt: c.createdAt,
        userId: c.userId,
      }))

    return jsonResponse({ conversations, nextCursor: result.nextCursor, previousCursor: result.previousCursor })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.error("failed to list conversations:", e)
    return jsonResponse({ status: "error", message, conversations: [] }, 500)
  }
}
