/**
 * Sign out — Vercel-native route, POST /auth-logout.
 *
 * Vercel-native equivalent of cloud-functions/auth-logout/index.ts. Just
 * clears Devon's session cookie — no store involved, so there's nothing
 * EdgeOne-specific to swap out here. The account's synced data stays on the
 * server; signing in again restores it.
 */

import { clearCookieHeader, isHttps, json, SESSION_COOKIE } from "@/cloud-functions/_auth/config"

export const runtime = "nodejs"

export async function POST(request: Request): Promise<Response> {
  const secure = isHttps(request, process.env)
  return json({ ok: true }, 200, [clearCookieHeader(SESSION_COOKIE, secure)])
}
