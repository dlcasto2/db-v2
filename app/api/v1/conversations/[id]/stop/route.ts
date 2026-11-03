/**
 * Devon AI Public API — POST /api/v1/conversations/:id/stop
 *
 * Signal Devon AI to stop generating for this conversation.
 *
 * Response:
 *   { conversation_id, status: "aborting" | "idle" }
 */

import { redis } from "@/lib/devon-ai/server/kv"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("api-v1-stop")
const STOP_FLAG_TTL = 120

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8" },
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: conversationId } = await params
  if (!conversationId) {
    return json({ error: { code: "MISSING_ID", message: "Conversation ID is required." } }, 400)
  }

  const r = redis()
  let flagged = false
  if (r) {
    try {
      await r.set(`devon:stop:${conversationId}`, "1", { ex: STOP_FLAG_TTL })
      flagged = true
    } catch (e) {
      logger.error("[stop] failed to set flag:", e)
    }
  }

  return json({
    conversation_id: conversationId,
    status: flagged ? "aborting" : "idle",
  })
}
