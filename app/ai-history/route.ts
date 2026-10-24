/**
 * Devon AI history — Vercel-native route, POST /ai-history.
 *
 * Vercel-native equivalent of cloud-functions/ai-history/index.ts, against
 * lib/devon-ai/server/store.ts instead of EdgeOne's context.agent.store.
 * Same request/response shape, so lib/devon-ai/api.ts needs no changes.
 */

import { createAiStore, type StoredMessage } from "@/lib/devon-ai/server/store"
import { createLogger } from "@/agents/_logger"
import { redactBase64InText } from "@/agents/_redact"

export const runtime = "nodejs"

const logger = createLogger("ai-history")
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

type FrontendMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: number
  page?: { url: string; title: string }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

function pageOf(metadata: StoredMessage["metadata"]): FrontendMessage["page"] {
  const page = (metadata as { page?: { url?: unknown; title?: unknown } } | undefined)?.page
  if (!page || typeof page.url !== "string") return undefined
  return { url: page.url, title: typeof page.title === "string" ? page.title : "" }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return redactBase64InText(content)
  if (Array.isArray(content)) {
    return content
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => redactBase64InText(String(item.text ?? item.output_text ?? "")))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : typeof body.conversationId === "string" ? body.conversationId : ""
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : typeof body.userId === "string" ? body.userId.trim() : ""

  if (!conversationId) return jsonResponse({ conversation_id: conversationId, messages: [] })

  try {
    const store = createAiStore(conversationId)
    const history = await store.getMessages({ conversationId, limit: 100, order: "asc", ...(userId ? { userId } : {}) })

    const messages: FrontendMessage[] = []
    for (const item of history) {
      if (item.role !== "user" && item.role !== "assistant") continue
      const content = contentToText(item.content)
      if (!content) continue
      const page = item.role === "user" ? pageOf(item.metadata) : undefined
      messages.push({
        id: item.messageId,
        role: item.role,
        content,
        timestamp: item.createdAt,
        ...(page ? { page } : {}),
      })
    }
    return jsonResponse({ conversation_id: conversationId, messages })
  } catch (e) {
    logger.error("failed to get messages:", e)
    return jsonResponse({ conversation_id: conversationId, messages: [] })
  }
}
