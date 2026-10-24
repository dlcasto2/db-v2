/**
 * Devon AI stop — Vercel-native route, POST /ai-stop.
 *
 * EdgeOne's agents/ai-stop/index.ts calls context.utils.abortActiveRun(id),
 * which works because EdgeOne can reach the same in-process run from another
 * request. Vercel gives no such guarantee — a separate POST /ai-stop may land
 * on a different instance than the running /ai-chat — so this sets a flag in
 * Redis instead, and app/ai-chat/route.ts polls for it (see STOP_POLL_MS
 * there). In the common case (the same browser tab clicking Stop) the running
 * fetch to /ai-chat is also aborted client-side, same as the EdgeOne version,
 * so this mainly matters when that doesn't land fast enough or when Stop is
 * triggered from a different connection.
 */

import { redis } from "@/lib/devon-ai/server/kv"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("ai-stop")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }
const STOP_FLAG_TTL_SECONDS = 120

function stopKey(conversationId: string): string {
  return `devon:stop:${conversationId}`
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : ""

  if (!conversationId) {
    return new Response(JSON.stringify({ status: "error", message: "conversation_id is required" }), {
      status: 400,
      headers: JSON_HEADERS,
    })
  }

  const r = redis()
  let aborted = false
  if (r) {
    try {
      await r.set(stopKey(conversationId), "1", { ex: STOP_FLAG_TTL_SECONDS })
      aborted = true
    } catch (e) {
      logger.error("[stop] couldn't set the stop flag:", e)
    }
  }
  logger.log("conversationId:", conversationId, "flagged:", aborted)

  return new Response(JSON.stringify({ status: aborted ? "aborting" : "idle", conversationId }), {
    status: 200,
    headers: JSON_HEADERS,
  })
}
