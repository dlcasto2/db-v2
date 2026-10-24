/**
 * Devon AI feedback — Vercel-native route, POST /ai-feedback.
 *
 * Vercel-native equivalent of cloud-functions/ai-feedback/index.ts, reusing
 * agents/_feedback.ts unchanged (it's written against the same
 * Pick<AgentMemory, "appendMessage" | "getMessages"> shape every other
 * agents/_*.ts file uses, which lib/devon-ai/server/store.ts's Redis-backed
 * store satisfies). Same two actions, same request/response shape:
 *
 * 1. Record a thumbs up/down (no auth): { conversation_id, message_id,
 *    rating, reason?, note?, task_type? } -> { status: "ok" }.
 * 2. Read the aggregate digest (maintainer only): { action: "digest",
 *    admin_key, days?, limit? } -> { summary, entries }, refused with 403
 *    unless admin_key matches DEVON_AI_ADMIN_KEY in Vercel's project
 *    environment variables (refused the same way if that variable is unset).
 */

import { listFeedback, recordFeedback, summarizeFeedback } from "@/agents/_feedback"
import { resolveModelName } from "@/agents/_model"
import { createLogger } from "@/agents/_logger"
import { createAiStore } from "@/lib/devon-ai/server/store"

export const runtime = "nodejs"

const logger = createLogger("ai-feedback")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return jsonResponse({ status: "error", message: "Invalid JSON body" }, 400)

  const env = process.env
  // Feedback entries live in reserved df-<day> buckets, not any real chat's
  // own conversation, so any conversationId works to get a store instance —
  // every call below names its own target bucket explicitly.
  const store = createAiStore("ai-feedback")

  if (body.action === "digest") {
    const adminKey = env.DEVON_AI_ADMIN_KEY
    const givenKey = typeof body.admin_key === "string" ? body.admin_key : ""
    if (!adminKey || givenKey !== adminKey) return jsonResponse({ status: "error", message: "Not authorized" }, 403)
    const days = typeof body.days === "number" ? body.days : undefined
    const limit = typeof body.limit === "number" ? body.limit : undefined
    const entries = await listFeedback(store, { days, limit }, logger.error)
    return jsonResponse({ summary: summarizeFeedback(entries), entries })
  }

  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : typeof body.conversationId === "string" ? body.conversationId : ""
  const messageId = typeof body.message_id === "string" ? body.message_id : typeof body.messageId === "string" ? body.messageId : ""
  if (!conversationId || !messageId) return jsonResponse({ status: "error", message: "conversation_id and message_id are required" }, 400)

  const ok = await recordFeedback(
    store,
    {
      conversationId,
      messageId,
      rating: body.rating,
      reason: body.reason,
      note: body.note,
      model: resolveModelName(env),
      taskType: body.task_type ?? body.taskType,
    },
    logger.error,
  )
  return jsonResponse(ok ? { status: "ok" } : { status: "error", message: "Could not record feedback right now" }, ok ? 200 : 500)
}
