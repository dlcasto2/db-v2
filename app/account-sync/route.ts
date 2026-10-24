/**
 * Account sync — Vercel-native route, GET/POST /account-sync.
 *
 * Vercel-native equivalent of cloud-functions/account-sync/index.ts, against
 * lib/devon-ai/server/store.ts (Redis) instead of EdgeOne's
 * context.agent.store — the same swap Devon AI's own Vercel routes make (see
 * app/ai-history/route.ts). Same request/response shape, so lib/account.ts
 * needs no changes.
 *
 *   GET   -> the signed-in account's bookmarks, history and settings
 *   POST  -> merges the browser's copy into the server's, returns the result
 *
 * The data is keyed to the subject (sub) taken from Devon's session cookie —
 * never from anything the client supplies — so one account can only ever
 * read or write its own data. Without Redis configured (see
 * lib/devon-ai/server/kv.ts), sync simply reports itself unavailable, same as
 * an EdgeOne deployment with no Makers store.
 */

import { createLogger } from "@/agents/_logger"
import { redisConfigured } from "@/lib/devon-ai/server/kv"
import { createAiStore } from "@/lib/devon-ai/server/store"
import { mergeSync, normalizeSyncData } from "@/cloud-functions/_auth/sync"
import {
  accountNamespace,
  authConfig,
  json,
  parseCookies,
  readSession,
  readSyncRaw,
  writeSyncRaw,
} from "@/cloud-functions/_auth/config"

export const runtime = "nodejs"

const logger = createLogger("account-sync")

async function session(request: Request) {
  const cfg = authConfig(process.env)
  const cookies = parseCookies(request.headers.get("cookie"))
  return readSession(cookies, cfg.signingSecret)
}

export async function GET(request: Request): Promise<Response> {
  const user = await session(request)
  if (!user) return json({ error: "not signed in" }, 401)
  if (!redisConfigured()) return json({ available: false }, 200)
  try {
    const ns = await accountNamespace(user.sub)
    const store = createAiStore(ns)
    const data = normalizeSyncData(await readSyncRaw(store, ns))
    return json({ available: true, data })
  } catch (e) {
    logger.error("pull failed:", e)
    return json({ available: false }, 200)
  }
}

export async function POST(request: Request): Promise<Response> {
  const user = await session(request)
  if (!user) return json({ error: "not signed in" }, 401)
  if (!redisConfigured()) return json({ available: false }, 200)

  let incoming: unknown = {}
  try {
    incoming = await request.json()
  } catch {
    // empty / unparseable body -> treat as nothing to push
  }

  try {
    const ns = await accountNamespace(user.sub)
    const store = createAiStore(ns)
    const pushed = normalizeSyncData(incoming)
    if (!pushed.settingsAt && pushed.settings) pushed.settingsAt = Date.now()
    const stored = normalizeSyncData(await readSyncRaw(store, ns))
    const merged = mergeSync(stored, pushed)
    await writeSyncRaw(store, ns, merged)
    return json({ available: true, data: merged })
  } catch (e) {
    logger.error("push failed:", e)
    return json({ available: false }, 200)
  }
}
