/**
 * Sign-in callback — EdgeOne Makers Node Function (GET /auth-callback).
 *
 * Auth0 redirects here with a one-time code. This verifies the state against
 * the cookie set at the start, exchanges the code for tokens server-to-server
 * (the client secret and PKCE verifier never touch the browser), reads the
 * identity from the ID token, and sets Devon's own signed session cookie. No
 * provider token is ever handed to the browser.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"
import { decodeIdToken, validateClaims, verifyToken } from "../_auth/core"
import {
  authConfig,
  clearCookieHeader,
  cookieHeader,
  isHttps,
  makeSessionToken,
  OAUTH_COOKIE,
  originOf,
  parseCookies,
  redirect,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from "../_auth/config"

const logger = createLogger("auth-callback")

interface OAuthState {
  state: string
  nonce: string
  verifier: string
  exp: number
}

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const request = context.request!
  const origin = originOf(request)
  const cfg = authConfig(context.env)
  const secure = isHttps(request)
  const dropOauth = clearCookieHeader(OAUTH_COOKIE, secure)
  const back = (status: string, cookies: string[] = [dropOauth]) => redirect(`${origin}/?signin=${status}`, cookies)

  if (!cfg.enabled) return back("unavailable")

  const url = new URL(request.url)
  if (url.searchParams.get("error")) return back("cancelled")
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) return back("error")

  // The start endpoint's cookie carries the expected state, nonce and PKCE verifier
  const saved = await verifyToken<OAuthState>(
    parseCookies(request.headers.get("cookie"))[OAUTH_COOKIE] || "",
    cfg.signingSecret,
  )
  if (!saved) return back("expired")
  if (saved.state !== state) return back("error")

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${origin}/auth-callback`,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: saved.verifier,
    })
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    })
    if (!res.ok) {
      logger.error("token exchange failed:", res.status, (await res.text()).slice(0, 200))
      return back("error")
    }
    const tokens = (await res.json()) as { id_token?: string }
    if (!tokens.id_token) return back("error")

    // The ID token came straight from Auth0's token endpoint over TLS, so the
    // channel vouches for it; we still check issuer, audience, expiry and nonce.
    const check = validateClaims(decodeIdToken(tokens.id_token), {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      nonce: saved.nonce,
    })
    if (!check.ok) {
      logger.error("ID token rejected:", check.reason)
      return back("error")
    }
    const c = check.claims
    const session = await makeSessionToken(
      { sub: c.sub, email: c.email, name: c.name, picture: c.picture },
      cfg.signingSecret,
    )
    return back("ok", [cookieHeader(SESSION_COOKIE, session, { maxAge: SESSION_MAX_AGE, secure }), dropOauth])
  } catch (e) {
    logger.error("callback error:", e)
    return back("error")
  }
}
