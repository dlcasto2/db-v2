import type { CloudFunctionContext } from "@edgeone/types"
import { handleFileSystemRequest } from "../../lib/devon-ai/filesystem-api"
import type { FileStore } from "../../lib/devon-ai/filesystem"
import { createLogger } from "../_logger"

const logger = createLogger("ai-filesystem")
const headers = { "Content-Type": "application/json; charset=UTF-8" } as const

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const conversationId = context.agent?.conversation_id || ""
  if (!conversationId || /^(d[qft]|acct)-/.test(conversationId)) {
    return json({ error: "Send a valid chat ID in the makers-conversation-id header." }, 400)
  }
  let input: Record<string, unknown> = {}
  try {
    const body = await context.request!.json()
    if (body && typeof body === "object" && !Array.isArray(body)) input = body as Record<string, unknown>
  } catch {
    return json({ error: "The filesystem request body must be valid JSON." }, 400)
  }
  try {
    const result = await handleFileSystemRequest(context.agent!.store as FileStore, conversationId, input)
    if (result.text) return new Response(result.text, { status: result.status, headers: { "Content-Type": "text/plain; charset=UTF-8" } })
    return json(result.body, result.status)
  } catch (error) {
    logger.error("filesystem request failed:", error)
    return json({ error: error instanceof Error ? error.message : "The filesystem action failed." }, 500)
  }
}
