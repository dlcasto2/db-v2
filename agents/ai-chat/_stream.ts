/**
 * Devon AI's SSE stream (private module, not a route).
 *
 * Adapted from TencentEdgeOne/claude-agent-starter-node (MIT). Runs one Claude
 * Agent SDK query and turns its messages into the events Devon's chat reads:
 *
 *   quota       { used, limit, resetAt }        sent first
 *   session     { session }                     this chat's session state (first, and after each change)
 *   page_action { callId, tool, args }          run a page tool in the visitor's Devon tab (see _mailbox.ts)
 *   text_delta  { delta }                       assistant text, token by token
 *   tool_called { tool }                        a sandbox tool started
 *   skill_loaded { name }                       a project skill was loaded
 *   image       { imageId, base64, mimeType, size }  screenshot / chart from a tool
 *   notice      { code, message }               non-fatal problem (e.g. web search not set up)
 *   error       { message }                     the run failed
 *   ping        {}                              every 5 s, keeps proxies from closing the stream
 *   done        { stopped }                     always last
 *
 * The starter's debug events (full SDK message dumps) are left out: Devon
 * doesn't show them and they'd send tool internals to every visitor.
 */

import { query } from "@anthropic-ai/claude-agent-sdk"
import type { AgentMemory } from "@edgeone/types"
import { redactBase64Deep } from "../_redact"
import type { QuotaStatus } from "../_quota"
import type { SessionState } from "../_session"
import type { StreamChannel } from "./_devon-tools"

interface Logger {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface CreateChatStreamOptions {
  prompt: string
  options: Record<string, unknown>
  signal?: AbortSignal
  logger: Logger
  conversationId: string
  store: AgentMemory
  botMsgId?: string
  userId?: string
  quota: QuotaStatus
  session: SessionState
  /** Filled in when the stream starts, so tools can send events down it */
  channel: StreamChannel
}

type SdkBlock = { type?: string; text?: string; name?: string; id?: string; input?: unknown; source?: { type?: string; media_type?: string; data?: string } }
type SdkMessage = {
  type?: string
  subtype?: string
  session_id?: unknown
  message?: { content?: unknown }
  tool_use_result?: unknown
}

const HEARTBEAT_MS = 5000

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** mcp__edgeone__commands → commands */
function extractToolName(rawName: string): string {
  return rawName.includes("__") ? rawName.split("__").pop() || rawName : rawName
}

function safeJsonPreview(value: unknown, maxLength = 800): string {
  try {
    const quick = typeof value === "string" ? value : JSON.stringify(value)
    const redacted = quick?.includes("base64Image") ? redactBase64Deep(value, "[image]") : value
    const text = JSON.stringify(redacted)
    if (!text) return String(value)
    return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text
  } catch {
    return String(value)
  }
}

/**
 * Remove image data URIs from assistant prose. Tool images arrive as `image`
 * events; if the model also pastes a base64 blob into its text, it would land
 * in the chat as a wall of characters.
 */
function sanitizeAssistantText(text: string): string {
  return text
    .replace(/!\[[^\]]*]\(\s*data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]+\s*\)/gi, "")
    .replace(/!\[[^\]]*]\(\s*data:image\/[^;)\s]+;base64,[\s\S]*$/gi, "")
    .replace(/data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]+/gi, "")
    .replace(/data:image\/[^;)\s]+;base64,[A-Za-z0-9+/=]*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart()
}

export function createChatStream({
  prompt,
  options,
  signal,
  logger,
  conversationId,
  store,
  botMsgId,
  userId,
  quota,
  session,
  channel,
}: CreateChatStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let stopped = false
  let closed = false
  let fullAssistantText = ""
  const sentTextLenByBlock = new Map<number, number>()
  let wsaNoticeSent = false
  let imageCount = 0

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        if (event === "image") imageCount++
        if (closed) return
        try {
          controller.enqueue(encoder.encode(sseFrame(event, data)))
        } catch {
          closed = true
        }
      }
      channel.send = send
      const heartbeat = setInterval(() => send("ping", {}), HEARTBEAT_MS)

      const emitToolResults = (msg: SdkMessage) => {
        try {
          // The SDK's own copy of the result if it has one, else the tool_result
          // blocks in the message (whose content holds the actual parts)
          const items: Array<(SdkBlock & { content?: unknown; data?: unknown; mimeType?: unknown }) | string> = []
          const collect = (value: unknown, depth: number) => {
            if (value == null || depth > 4) return
            if (Array.isArray(value)) {
              for (const v of value) collect(v, depth + 1)
              return
            }
            if (typeof value === "object") {
              const v = value as { type?: unknown; content?: unknown }
              // tool_result blocks and MCP CallToolResults ({ content: [...] }) wrap the parts
              if (v.type === "tool_result" || (v.type === undefined && Array.isArray(v.content))) {
                collect(v.content, depth + 1)
                return
              }
            }
            items.push(value as (typeof items)[number])
          }
          collect(msg.tool_use_result ?? msg.message?.content ?? [], 0)

          for (const item of items) {
            // Anthropic image block: { type: "image", source: { type: "base64", media_type, data } }
            if (typeof item !== "string" && item?.type === "image" && item.source?.type === "base64" && item.source.data) {
              send("image", {
                imageId: crypto.randomUUID(),
                base64: item.source.data,
                mimeType: item.source.media_type || "image/png",
                size: item.source.data.length,
              })
              continue
            }
            // MCP image content: { type: "image", data, mimeType }
            if (typeof item !== "string" && item?.type === "image" && typeof item.data === "string" && item.data) {
              send("image", {
                imageId: crypto.randomUUID(),
                base64: item.data,
                mimeType: typeof item.mimeType === "string" ? item.mimeType : "image/png",
                size: item.data.length,
              })
              continue
            }
            const text = typeof item === "string" ? item : (item?.text ?? (typeof item?.content === "string" ? item.content : ""))
            if (typeof text === "string" && text.includes("base64Image")) {
              try {
                const parsed = JSON.parse(text) as { base64Image?: string }
                if (parsed.base64Image) {
                  send("image", {
                    imageId: crypto.randomUUID(),
                    base64: parsed.base64Image,
                    mimeType: "image/png",
                    size: parsed.base64Image.length,
                  })
                }
              } catch {
                // not JSON
              }
            }
          }
          // The web search tool needs WSA_API_KEY; say so once instead of failing quietly
          if (!wsaNoticeSent) {
            const preview = safeJsonPreview(msg, 4000)
            if (preview.includes("WSA_API_KEY")) {
              wsaNoticeSent = true
              send("notice", { code: "wsa_missing", message: "Web search isn't set up on this Devon (WSA_API_KEY is missing)." })
            }
          }
        } catch (e) {
          logger.error("[image] failed to read tool result:", e)
        }
      }

      const emitAssistantBlocks = (msg: SdkMessage) => {
        const blocks = (Array.isArray(msg.message?.content) ? msg.message?.content : []) as SdkBlock[]
        blocks.forEach((block, idx) => {
          if (block.type === "text") {
            const text = sanitizeAssistantText(block.text || "")
            const alreadySent = sentTextLenByBlock.get(idx) ?? 0
            if (text.length > alreadySent) {
              sentTextLenByBlock.set(idx, text.length)
              fullAssistantText = text
              send("text_delta", { delta: text.slice(alreadySent) })
            }
          } else if (block.type === "tool_use") {
            const rawName = block.name || ""
            const tool = extractToolName(rawName)
            logger.log("[tools] call", { cid: conversationId, tool, input: safeJsonPreview(block.input) })
            send("tool_called", { tool })
            const isSkillTool = tool === "Skill" || tool === "load_skill" || rawName.endsWith("Skill")
            if (isSkillTool && block.input && typeof block.input === "object") {
              const input = block.input as Record<string, unknown>
              const name = input.skill ?? input.name ?? input.skillName
              if (typeof name === "string") send("skill_loaded", { name })
            }
          }
        })
      }

      try {
        send("quota", { used: quota.used, limit: quota.limit, resetAt: quota.resetAt })
        send("session", { session })

        const abortController = new AbortController()
        if (signal?.aborted) abortController.abort()
        else signal?.addEventListener("abort", () => abortController.abort(), { once: true })

        const q = query({ prompt, options: { ...options, abortController } as Parameters<typeof query>[0]["options"] })
        let lastMsgType = ""

        for await (const raw of q) {
          if (signal?.aborted) {
            stopped = true
            break
          }
          const msg = raw as SdkMessage
          // A new assistant round after tool results: its text blocks start from 0 again
          if (msg.type === "assistant" && lastMsgType === "user") sentTextLenByBlock.clear()
          lastMsgType = msg.type ?? ""

          if (msg.type === "user") emitToolResults(msg)
          else if (msg.type === "assistant") emitAssistantBlocks(msg)
          else if (msg.type === "result") {
            if (typeof msg.session_id === "string") logger.log("[session] result session_id:", msg.session_id)
            break
          }
        }
      } catch (e: unknown) {
        const error = e as Error
        if (error?.name === "AbortError" || signal?.aborted) {
          stopped = true
          logger.log("[stream] aborted by user")
        } else {
          logger.error("[stream] error:", error?.name, error?.message, error?.stack)
          const cause = (error as { cause?: unknown })?.cause
          if (cause !== undefined) logger.error("[stream] cause:", cause)
          send("error", { message: String(error?.message ?? e) })
        }
      } finally {
        clearInterval(heartbeat)
        // Save the reply (even an image-only one) so the history matches what was shown
        if (conversationId && botMsgId) {
          const content =
            sanitizeAssistantText(fullAssistantText).trim() || (imageCount ? "[image]" : stopped ? "(stopped)" : "(no reply)")
          try {
            await store.appendMessage({ conversationId, role: "assistant", content, ...(userId ? { userId } : {}), messageId: botMsgId } as Parameters<AgentMemory["appendMessage"]>[0])
          } catch (e) {
            logger.error("[store] failed to save the reply:", e)
          }
        }
        send("done", { stopped })
        closed = true
        try {
          controller.close()
        } catch {
          // already closed by a disconnected client
        }
      }
    },
    cancel() {
      closed = true
      logger.log("[stream] client disconnected")
    },
  })
}
