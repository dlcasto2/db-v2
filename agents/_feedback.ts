/**
 * Devon AI feedback log (private module, not a route).
 *
 * A visitor's thumbs up/down on a reply, with an optional reason chip and a
 * short free-text note. Deliberately a small, append-only log — not the page,
 * not the conversation, not anything the visitor didn't type into the note
 * field themselves:
 *
 *   { id, conversationId, messageId, rating, reason?, note?, model, taskType, at }
 *
 * That's on purpose: a right/wrong marker on its own is nearly unactionable
 * (you can't tell "wrong fact" from "didn't like the tone" from "the page was
 * cut off"), so the reason chip is what makes the log worth reviewing, while
 * keeping the log itself a privacy-light summary rather than a data dump. A
 * maintainer reviews it as an aggregate digest (see cloud-functions/ai-feedback
 * and app/ai-feedback) — not a notification per click — and any free-text note
 * is untrusted visitor input, never evaluated or executed, only ever displayed
 * back as plain text to whoever reads the digest.
 *
 * Stored the same way agents/_quota.ts stores its counters: as JSON entries
 * appended to a small, reserved "conversation" per day (df-<yyyy-mm-dd>; see
 * the d[qft]|acct guard in the ai-chat/ai-session/etc. routes, which refuses
 * visitor chats from ever writing into one of these buckets). Written against
 * Pick<AgentMemory, ...>, like every other file in this folder, so the same
 * module runs unchanged on EdgeOne and on the Redis-backed store Vercel uses.
 */

import type { AgentMemory } from "@edgeone/types"

type FeedbackStore = Pick<AgentMemory, "appendMessage" | "getMessages">

export type FeedbackRating = "up" | "down"
export type FeedbackReason = "wrong_fact" | "misread_page" | "bad_action" | "other"

export interface FeedbackEntry {
  id: string
  conversationId: string
  messageId: string
  rating: FeedbackRating
  reason?: FeedbackReason
  note?: string
  model: string
  taskType: string
  at: number
}

const LIMITS = { note: 300, model: 80, taskType: 40, days: 60, listLimit: 1000 }
const REASONS: FeedbackReason[] = ["wrong_fact", "misread_page", "bad_action", "other"]

function clip(s: unknown, max: number): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : ""
}

function dayBucket(at: number): string {
  return `df-${new Date(at).toISOString().slice(0, 10)}`
}

export interface RecordFeedbackInput {
  conversationId: string
  messageId: string
  rating: unknown
  reason?: unknown
  note?: unknown
  model: string
  taskType?: unknown
}

/** Validates and appends one entry; returns false (and logs) only on a real store failure */
export async function recordFeedback(store: FeedbackStore, input: RecordFeedbackInput, logError: (...a: unknown[]) => void): Promise<boolean> {
  const rating: FeedbackRating = input.rating === "down" ? "down" : "up"
  const reason = REASONS.includes(input.reason as FeedbackReason) ? (input.reason as FeedbackReason) : undefined
  const note = clip(input.note, LIMITS.note)
  const at = Date.now()
  const entry: FeedbackEntry = {
    id: crypto.randomUUID(),
    conversationId: clip(input.conversationId, 64),
    messageId: clip(input.messageId, 64),
    rating,
    ...(rating === "down" && reason ? { reason } : {}),
    ...(rating === "down" && note ? { note } : {}),
    model: clip(input.model, LIMITS.model) || "unknown",
    taskType: clip(input.taskType, LIMITS.taskType) || "chat",
    at,
  }
  try {
    await store.appendMessage({ conversationId: dayBucket(at), role: "user", content: entry as unknown as Record<string, unknown> })
    return true
  } catch (e) {
    logError("[feedback] couldn't record an entry:", e)
    return false
  }
}

function asEntry(content: unknown): FeedbackEntry | null {
  try {
    const obj = typeof content === "string" ? JSON.parse(content) : content
    if (obj && typeof obj === "object" && typeof (obj as FeedbackEntry).id === "string" && typeof (obj as FeedbackEntry).at === "number") {
      return obj as FeedbackEntry
    }
  } catch {
    // not JSON — skip
  }
  return null
}

/** Recent feedback across the last `days` day-buckets, newest first, capped at `limit` */
export async function listFeedback(
  store: FeedbackStore,
  opts: { days?: number; limit?: number },
  logError: (...a: unknown[]) => void,
): Promise<FeedbackEntry[]> {
  const days = Math.min(Math.max(opts.days ?? 14, 1), LIMITS.days)
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), LIMITS.listLimit)
  const now = Date.now()
  const out: FeedbackEntry[] = []
  for (let i = 0; i < days; i++) {
    try {
      const entries = await store.getMessages({ conversationId: dayBucket(now - i * 86_400_000), limit: 500, order: "desc" })
      for (const e of Array.isArray(entries) ? entries : []) {
        const parsed = asEntry(e.content)
        if (parsed) out.push(parsed)
      }
    } catch (e) {
      logError("[feedback] couldn't read a day bucket:", e)
    }
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, limit)
}

export interface FeedbackSummary {
  total: number
  up: number
  down: number
  byReason: Record<string, number>
  byTaskType: Record<string, number>
}

export function summarizeFeedback(entries: FeedbackEntry[]): FeedbackSummary {
  const byReason: Record<string, number> = {}
  const byTaskType: Record<string, number> = {}
  let up = 0
  let down = 0
  for (const e of entries) {
    if (e.rating === "up") up++
    else down++
    if (e.reason) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1
    byTaskType[e.taskType] = (byTaskType[e.taskType] ?? 0) + 1
  }
  return { total: entries.length, up, down, byReason, byTaskType }
}
