/**
 * Devon AI page-action results — EdgeOne Makers Node Function
 * ===========================================================
 *
 * cloud-functions/ai-page-result/index.ts maps to **POST /ai-page-result**.
 *
 * When Devon AI uses a page tool, the visitor's Devon tab performs the action
 * and posts the outcome here:
 *   { conversation_id, call_id, ok, text, tab?: { id, url, title } }
 * It goes into the chat's mailbox in the platform store, where the waiting
 * agent tool picks it up (agents/_mailbox.ts, which has the same mailboxKey).
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"

const logger = createLogger("ai-page-result")

const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" } as const
const MAX_TEXT = 40_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function mailboxKey(conversationId: string): string {
  return `dt-${conversationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await context.request!.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    // empty body
  }
  const conversationId = clip(body.conversation_id ?? body.conversationId, 64).trim()
  const callId = clip(body.call_id ?? body.callId, 64)
  if (!conversationId || /^d[qt]-/.test(conversationId) || !UUID_RE.test(callId)) {
    return jsonResponse({ status: "error", message: "conversation_id and a valid call_id are required" }, 400)
  }

  const rawTab = body.tab && typeof body.tab === "object" ? (body.tab as Record<string, unknown>) : null
  const tab = rawTab && typeof rawTab.url === "string" ? { id: clip(rawTab.id, 40), url: clip(rawTab.url, 2000), title: clip(rawTab.title, 300) } : undefined
  let text = clip(body.text, MAX_TEXT)
  if (typeof body.text === "string" && body.text.length > MAX_TEXT) text += "\n[…cut off]"

  try {
    await context.agent!.store.appendMessage({
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
