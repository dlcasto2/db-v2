/**
 * Sign out — EdgeOne Makers Node Function (POST /auth-logout).
 *
 * Clears Devon's session cookie. The account's synced data stays on the
 * server; signing in again restores it.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { clearCookieHeader, isHttps, json, SESSION_COOKIE } from "../_auth/config"

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const secure = context.request ? isHttps(context.request) : true
  return json({ ok: true }, 200, [clearCookieHeader(SESSION_COOKIE, secure)])
}
