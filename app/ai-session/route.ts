/**
 * Devon AI session state — Vercel-native route, POST /ai-session.
 *
 * Vercel-native equivalent of cloud-functions/ai-session/index.ts, against
 * the same conversation-scoped state store agents/_session.ts already uses
 * (SESSION_KEY), now backed by Redis instead of EdgeOne's store.state. Send
 * the chat's ID in the makers-conversation-id header, same as the EdgeOne
 * version; body { action?: "get" | "clear" }.
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { SESSION_KEY } from "@/agents/_session"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("ai-session")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const conversationId = request.headers.get("makers-conversation-id") || ""
  if (!conversationId || /^(d[qt]|acct)-/.test(conversationId)) {
    return jsonResponse({ status: "error", message: "Send the chat ID in the makers-conversation-id header" }, 400)
  }

  const store = createAiStore(conversationId)
  try {
    if (body.action === "clear") {
      await store.state.delete(SESSION_KEY)
      return jsonResponse({ session: null, available: true })
    }
    const session = await store.state.get(SESSION_KEY)
    return jsonResponse({ session: session ?? null, available: true })
  } catch (e) {
    logger.error("store.state unavailable:", e)
    return jsonResponse({ session: null, available: false })
  }
}
