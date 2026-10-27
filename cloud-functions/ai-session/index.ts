/**
 * Devon AI session state — EdgeOne Makers Node Function
 * =====================================================
 *
 * cloud-functions/ai-session/index.ts maps to **POST /ai-session**.
 *
 * Reads or clears one chat's session documents (task, steps, notes, pages used),
 * which the agent keeps under the conversation-scoped `/session` mount.
 * Send the chat's ID in the `makers-conversation-id` header, which binds the
 * store to that conversation; body { action?: "get" | "clear" }.
 * Answers { session: <state or null>, available: boolean }.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"
import {
  clearSessionStore,
  readSessionDocuments,
  writeJournal,
  finishJournal,
  writeSessionDocuments,
  type FileStore,
} from "../../lib/devon-ai/filesystem"

const logger = createLogger("ai-session")
const SESSION_KEY = "devon_session"
const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" } as const

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = await context.request!.json()
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch {
    // empty body
  }
  const conversationId = context.agent?.conversation_id || ""
  if (!conversationId || /^(d[qft]|acct)-/.test(conversationId)) {
    return jsonResponse({ status: "error", message: "Send the chat ID in the makers-conversation-id header" }, 400)
  }
  const store = context.agent!.store
  try {
    if (body.action === "clear") {
      await clearSessionStore(store as FileStore, conversationId)
      return jsonResponse({ session: null, available: true })
    }
    const fs = store as FileStore
    let session: unknown = (await readSessionDocuments(fs, conversationId))?.state ?? null
    if (session === null) {
      const legacy = await store.state.get(SESSION_KEY)
      if (legacy !== null) {
        const migratedSession = normalizeSessionState(legacy)
        session = migratedSession
        const intent = await writeJournal(fs, conversationId, {
          action: "session_migration",
          phase: "intent",
          from: SESSION_KEY,
          at: new Date().toISOString(),
        })
        try {
          await writeSessionDocuments(fs, conversationId, migratedSession)
          await store.state.delete(SESSION_KEY)
          await finishJournal(fs, conversationId, intent.path, intent.version, {
            action: "session_migration",
            phase: "result",
            status: "success",
            whatChanged: "Migrated legacy session state into /session documents.",
            at: new Date().toISOString(),
          })
        } catch (error) {
          try {
            await finishJournal(fs, conversationId, intent.path, intent.version, {
              action: "session_migration",
              phase: "result",
              status: "error",
              result: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            })
          } catch (journalError) {
            logger.error("couldn't record failed session migration:", journalError)
          }
          throw error
        }
      }
    }
    if (session !== null) session = normalizeSessionState(session)
    return jsonResponse({ session, available: true })
  } catch (e) {
    // Older runtimes without conversation-bound state: the browser keeps its own copy
    logger.error("store.state unavailable:", e)
    return jsonResponse({ session: null, available: false })
  }
}

function normalizeSessionState(raw: unknown) {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const steps = Array.isArray(value.steps)
    ? value.steps
        .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === "object"))
        .map((step) => ({ text: typeof step.text === "string" ? step.text.slice(0, 200) : "", done: Boolean(step.done) }))
        .filter((step) => step.text)
        .slice(0, 20)
    : []
  const strings = (items: unknown, maxCount: number, maxLength: number) =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, maxLength)).filter(Boolean).slice(-maxCount) : []
  const pages = Array.isArray(value.pages)
    ? value.pages
        .filter((page): page is Record<string, unknown> => Boolean(page && typeof page === "object" && typeof (page as Record<string, unknown>).url === "string"))
        .map((page) => ({
          url: String(page.url).slice(0, 500),
          title: typeof page.title === "string" ? page.title.slice(0, 150) : "",
          at: Number(page.at) || 0,
          ...(typeof page.state === "string" ? { state: page.state.slice(0, 200) } : {}),
        }))
        .slice(0, 12)
    : []
  return {
    task: typeof value.task === "string" ? value.task.slice(0, 300) : "",
    steps,
    notes: strings(value.notes, 30, 300),
    openQuestions: strings(value.openQuestions, 15, 200),
    pages,
    updatedAt: Number(value.updatedAt) || 0,
  }
}
