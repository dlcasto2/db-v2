/**
 * Devon AI page-action results — Vercel-native route, POST /ai-page-result.
 *
 * Vercel-native equivalent of cloud-functions/ai-page-result/index.ts. When
 * Devon AI uses a page tool, the visitor's Devon tab performs the action and
 * posts the outcome here; it goes into the chat's mailbox (same mailboxKey()
 * as agents/_mailbox.ts, via lib/devon-ai/server/store.ts), where the waiting
 * agent tool (app/ai-chat/route.ts, via createDevonTools's waitForResult)
 * picks it up. Same request/response shape as the EdgeOne version.
 */

import { createAiStore } from "@/lib/devon-ai/server/store"
import { mailboxKey } from "@/agents/_mailbox"
import { createLogger } from "@/agents/_logger"

export const runtime = "nodejs"

const logger = createLogger("ai-page-result")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }
const MAX_TEXT = 40_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const conversationId = clip(body.conversation_id ?? body.conversationId, 64).trim()
  const callId = clip(body.call_id ?? body.callId, 64)
  if (!conversationId || /^(d[qft]|acct)-/.test(conversationId) || !UUID_RE.test(callId)) {
    return jsonResponse({ status: "error", message: "conversation_id and a valid call_id are required" }, 400)
  }

  const rawTab = body.tab && typeof body.tab === "object" ? (body.tab as Record<string, unknown>) : null
  const tab = rawTab && typeof rawTab.url === "string" ? { id: clip(rawTab.id, 40), url: clip(rawTab.url, 2000), title: clip(rawTab.title, 300) } : undefined
  let text = clip(body.text, MAX_TEXT)
  if (typeof body.text === "string" && body.text.length > MAX_TEXT) text += "\n[…cut off]"

  try {
    const store = createAiStore(conversationId)
    await store.appendMessage({
      conversationId: mailboxKey(conversationId),
      role: "user",
      content: JSON.stringify({ callId, ok: Boolean(body.ok), text, ...(tab ? { tab } : {}) }),
    })
    return jsonResponse({ status: "ok" })
  } catch (e) {
    logger.error("failed to store a page result:", e)
    return jsonResponse({ status: "error", message: e instanceof Error ? e.message : String(e) }, 500)
  }
}
