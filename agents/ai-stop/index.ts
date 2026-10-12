/**
 * Devon AI stop — EdgeOne Makers agent route
 * ==========================================
 *
 * agents/ai-stop/index.ts maps to **POST /ai-stop**. From
 * TencentEdgeOne/claude-agent-starter-node (MIT).
 *
 * Aborts the running reply for `conversation_id` (in the JSON body), which
 * breaks the loop in ai-chat and releases the upstream model connection.
 * The browser aborts its own fetch too, so this is the server half of Stop.
 */

import type { AgentContext } from "@edgeone/types"
import { createLogger } from "../_logger"

const logger = createLogger("ai-stop")

const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

export async function onRequest(context: AgentContext) {
  const body = (context.request?.body ?? {}) as Record<string, unknown>
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : ""

  if (!conversationId) {
    return new Response(JSON.stringify({ status: "error", message: "conversation_id is required" }), {
      status: 400,
      headers: JSON_HEADERS,
    })
  }

  const ret = context.utils.abortActiveRun(conversationId)
  logger.log("conversationId:", conversationId, "abortActiveRun:", ret)

  return new Response(JSON.stringify({ status: ret?.aborted ? "aborting" : "idle", conversationId, ...ret }), {
    status: 200,
    headers: JSON_HEADERS,
  })
}
