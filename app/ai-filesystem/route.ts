import { createAiStore } from "@/lib/devon-ai/server/store"
import { handleFileSystemRequest } from "@/lib/devon-ai/filesystem-api"
import type { FileStore } from "@/lib/devon-ai/filesystem"
import { createLogger } from "@/agents/_logger"
import { redis } from "@/lib/devon-ai/server/kv"

export const runtime = "nodejs"

const logger = createLogger("ai-filesystem")

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=UTF-8" } })
}

export async function POST(request: Request): Promise<Response> {
  const conversationId = request.headers.get("makers-conversation-id") || ""
  if (!conversationId || /^(d[qft]|acct)-/.test(conversationId)) {
    return json({ error: "Send a valid chat ID in the makers-conversation-id header." }, 400)
  }
  if (!redis()) return json({ error: "Conversation storage is unavailable; configure Redis before using the virtual filesystem." }, 503)
  const input = (await request.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const result = await handleFileSystemRequest(createAiStore(conversationId) as FileStore, conversationId, input)
    if (result.text) return new Response(result.text, { status: result.status, headers: { "Content-Type": "text/plain; charset=UTF-8" } })
    return json(result.body, result.status)
  } catch (error) {
    logger.error("filesystem request failed:", error)
    return json({ error: error instanceof Error ? error.message : "The filesystem action failed." }, 500)
  }
}
