/**
 * Devon AI daily message limit (private module, not a route).
 *
 * Each visitor gets DEVON_AI_DAILY_LIMIT messages per UTC day (default 30;
 * 0 turns the limit off). The count lives on the server in the platform's
 * conversation store, so refreshing the page, opening a new chat or a new tab
 * doesn't reset it. A visitor is the ID the browser keeps in localStorage.
 *
 * DEVON_AI_IP_DAILY_LIMIT (default 0 = off) adds a second, shared cap per
 * network address. It stops someone from dodging the visitor limit with
 * private windows, but everyone behind one school or office network shares
 * it, so set it well above the visitor limit if you turn it on.
 *
 * Each counter is its own small "conversation" in the store holding one entry
 * per message sent today ({ d: day, n: running count }). The first message of
 * a new day clears the old entries. Only documented store calls are used
 * (getMessages / appendMessage / clearMessages), and if the store fails the
 * message is let through rather than blocking everyone.
 */

import { createHash } from "node:crypto"
import type { AgentMemory } from "@edgeone/types"

type Env = Record<string, string | undefined>
type CounterStore = Pick<AgentMemory, "getMessages" | "appendMessage" | "clearMessages">

export interface QuotaStatus {
  /** False when this message is over a limit */
  ok: boolean
  /** Messages used today, counting this one when ok */
  used: number
  /** 0 = unlimited */
  limit: number
  /** Epoch ms when the counts reset (next UTC midnight) */
  resetAt: number
  /** Which limit was hit */
  scope?: "visitor" | "network"
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function quotaLimits(env: Env): { visitor: number; network: number } {
  return {
    visitor: intEnv(env.DEVON_AI_DAILY_LIMIT, 30),
    network: intEnv(env.DEVON_AI_IP_DAILY_LIMIT, 0),
  }
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/** Store key for a counter. Hashed, so raw IPs and visitor IDs aren't stored. */
function counterKey(kind: "v" | "ip", id: string): string {
  return `dq-${kind}-${createHash("sha256").update(`devon-ai:${kind}:${id}`).digest("hex").slice(0, 28)}`
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text
      }
    }
  }
  return ""
}

/** Today's count for one counter, and whether it holds entries from earlier days */
async function readCounter(store: CounterStore, key: string, day: string): Promise<{ count: number; stale: boolean }> {
  const entries = await store.getMessages({ conversationId: key, limit: 100, order: "desc" })
  let count = 0
  let stale = false
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const parsed = JSON.parse(contentText(entry.content)) as { d?: unknown; n?: unknown }
      if (parsed.d === day && typeof parsed.n === "number") count = Math.max(count, parsed.n)
      else stale = true
    } catch {
      stale = true
    }
  }
  return { count, stale: stale && count === 0 }
}

async function bumpCounter(store: CounterStore, key: string, day: string, count: number, stale: boolean) {
  if (stale) await store.clearMessages({ conversationId: key })
  await store.appendMessage({ conversationId: key, role: "user", content: JSON.stringify({ d: day, n: count + 1 }) })
}

/**
 * Counts one message for this visitor (and network, if that cap is on).
 * Nothing is counted when the message is refused.
 */
export async function takeQuota(
  store: CounterStore,
  env: Env,
  ids: { visitor: string; network?: string },
  logError: (...args: unknown[]) => void,
  now = Date.now(),
): Promise<QuotaStatus> {
  const limits = quotaLimits(env)
  const day = utcDay(now)
  const resetAt = nextUtcMidnight(now)

  const counters: { scope: "visitor" | "network"; key: string; limit: number }[] = []
  if (limits.visitor > 0) counters.push({ scope: "visitor", key: counterKey("v", ids.visitor), limit: limits.visitor })
  if (limits.network > 0 && ids.network) counters.push({ scope: "network", key: counterKey("ip", ids.network), limit: limits.network })
  if (!counters.length) return { ok: true, used: 0, limit: 0, resetAt }

  try {
    const current = await Promise.all(counters.map((c) => readCounter(store, c.key, day)))
    for (let i = 0; i < counters.length; i++) {
      if (current[i].count >= counters[i].limit) {
        const visitorIndex = counters.findIndex((c) => c.scope === "visitor")
        return {
          ok: false,
          used: visitorIndex >= 0 ? current[visitorIndex].count : current[i].count,
          limit: visitorIndex >= 0 ? counters[visitorIndex].limit : counters[i].limit,
          resetAt,
          scope: counters[i].scope,
        }
      }
    }
    await Promise.all(counters.map((c, i) => bumpCounter(store, c.key, day, current[i].count, current[i].stale)))
    const visitorIndex = counters.findIndex((c) => c.scope === "visitor")
    const shown = visitorIndex >= 0 ? visitorIndex : 0
    return { ok: true, used: current[shown].count + 1, limit: counters[shown].limit, resetAt }
  } catch (error) {
    // A store hiccup shouldn't lock everyone out of Devon AI
    logError("[quota] store unavailable, letting the message through:", error)
    return { ok: true, used: 0, limit: limits.visitor, resetAt }
  }
}
