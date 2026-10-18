/**
 * Account sync — EdgeOne Makers Node Function (/account-sync).
 *
 *   GET   -> the signed-in account's bookmarks, history and settings
 *   POST  -> merges the browser's copy into the server's, returns the result
 *
 * The data is keyed to the subject (sub) taken from Devon's session cookie —
 * never from anything the client supplies — so one account can only ever read
 * or write its own data. Only sign-in state travels in the cookie; the data
 * lives in the Makers store under an unguessable per-user namespace.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"
import { mergeSync, normalizeSyncData } from "../_auth/sync"
import {
  accountNamespace,
  authConfig,
  json,
  parseCookies,
  readSession,
  readSyncRaw,
  writeSyncRaw,
} from "../_auth/config"

const logger = createLogger("account-sync")

async function session(context: CloudFunctionContext) {
  const cfg = authConfig(context.env)
  const cookies = parseCookies(context.request?.headers.get("cookie"))
  return readSession(cookies, cfg.signingSecret)
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const user = await session(context)
  if (!user) return json({ error: "not signed in" }, 401)
  const store = context.agent?.store
  if (!store) return json({ available: false }, 200)
  try {
    const ns = await accountNamespace(user.sub)
    const data = normalizeSyncData(await readSyncRaw(store, ns))
    return json({ available: true, data })
  } catch (e) {
    logger.error("pull failed:", e)
    return json({ available: false }, 200)
  }
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const user = await session(context)
  if (!user) return json({ error: "not signed in" }, 401)
  const store = context.agent?.store
  if (!store) return json({ available: false }, 200)

  let incoming: unknown = {}
  try {
    incoming = await context.request!.json()
  } catch {
    // empty / unparseable body -> treat as nothing to push
  }

  try {
    const ns = await accountNamespace(user.sub)
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
