/**
 * Results of page actions, from the visitor's browser back to the agent
 * (private module, not a route).
 *
 * Page tools run in the visitor's Devon tab, not on the server. The agent sends
 * a `page_action` event down the chat stream; Devon performs it and POSTs the
 * result to /ai-page-result (a cloud function), which drops it in this chat's
 * mailbox in the platform store. The waiting tool polls the mailbox. Going
 * through the store means it works whichever instances the two requests reach.
 *
 * The mailbox is a store conversation named dt-<conversation id>; Devon AI
 * refuses chats with dq-/dt- IDs so nobody can write into one by chatting.
 * cloud-functions/ai-page-result has its own copy of mailboxKey().
 */

import type { AgentMemory } from "@edgeone/types"

type MailStore = Pick<AgentMemory, "getMessages" | "deleteMessage" | "clearMessages">

export interface PageResult {
  callId: string
  ok: boolean
  text: string
  image?: { base64: string; mimeType: string }
  /** The tab the action ended on */
  tab?: { id?: string; url: string; title: string }
}

export function mailboxKey(conversationId: string): string {
  return `dt-${conversationId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)}`
}

const POLL_MS = 350

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const part = content.find((p) => p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string")
    return part ? (part as { text: string }).text : ""
  }
  return ""
}

/** Empty the mailbox at the start of a run (drops results nobody waited for) */
export async function clearMailbox(store: MailStore, conversationId: string, logError: (...a: unknown[]) => void) {
  try {
    await store.clearMessages({ conversationId: mailboxKey(conversationId) })
  } catch (e) {
    logError("[mailbox] couldn't clear:", e)
  }
}

/** Wait for the browser's answer to one page action */
export async function waitForResult(
  store: MailStore,
  conversationId: string,
  callId: string,
  opts: { timeoutMs: number; signal?: AbortSignal; logError: (...a: unknown[]) => void },
): Promise<PageResult> {
  const key = mailboxKey(conversationId)
  const deadline = Date.now() + opts.timeoutMs
  let failures = 0
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { callId, ok: false, text: "Stopped by the user." }
    try {
      const entries = await store.getMessages({ conversationId: key, limit: 50, order: "desc" })
      for (const entry of Array.isArray(entries) ? entries : []) {
        let parsed: Partial<PageResult> | null = null
        try {
          parsed = JSON.parse(contentText(entry.content)) as Partial<PageResult>
        } catch {
          continue
        }
        if (parsed?.callId !== callId) continue
        const image = parsed.image
        const imageResult =
          image &&
          typeof image.base64 === "string" &&
          image.base64.length <= 400_000 &&
          (image.mimeType === "image/jpeg" || image.mimeType === "image/png")
            ? { base64: image.base64, mimeType: image.mimeType }
            : undefined
        try {
          await store.deleteMessage({ conversationId: key, messageId: entry.messageId })
        } catch {
          // the next clearMailbox removes it
        }
        return {
          callId,
          ok: Boolean(parsed.ok),
          text: typeof parsed.text === "string" ? parsed.text : "",
          image: imageResult,
          tab: parsed.tab && typeof parsed.tab.url === "string" ? parsed.tab : undefined,
        }
      }
      failures = 0
    } catch (e) {
      if (++failures === 3) opts.logError("[mailbox] reading results keeps failing:", e)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return {
    callId,
    ok: false,
    text: "Devon didn't answer in time. The tab may have been closed, the user may not have answered the permission prompt, or the page is busy.",
  }
}
