/**
 * Sign-in callback — Vercel-native route, GET /auth-callback.
 *
 * Vercel-native equivalent of cloud-functions/auth-callback/index.ts, against
 * process.env instead of EdgeOne's context.env. Same request/response shape,
 * so lib/account.ts needs no changes.
 */

import { createLogger } from "@/agents/_logger"
import { decodeIdToken, validateClaims, verifyToken } from "@/cloud-functions/_auth/core"
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
} from "@/cloud-functions/_auth/config"

export const runtime = "nodejs"

const logger = createLogger("auth-callback")

interface OAuthState {
  state: string
  nonce: string
  verifier: string
  /** The origin /auth-login authorized against; the token exchange must match it */
  origin?: string
  exp: number
}

export async function GET(request: Request): Promise<Response> {
  const cfg = authConfig(process.env)
  const secure = isHttps(request, process.env)
  const dropOauth = clearCookieHeader(OAUTH_COOKIE, secure)
  // Relative: the browser resolves it against the address it actually asked for,
  // so this works whatever the runtime thinks its own host is, and can't be aimed elsewhere.
  const back = (status: string, cookies: string[] = [dropOauth]) => redirect(`/?signin=${status}`, cookies)

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
      redirect_uri: `${saved.origin || originOf(request, process.env)}/auth-callback`,
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
