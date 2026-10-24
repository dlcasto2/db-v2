/**
 * Start sign-in — Vercel-native route, GET /auth-login.
 *
 * Vercel-native equivalent of cloud-functions/auth-login/index.ts, against
 * process.env instead of EdgeOne's context.env. Same request/response shape,
 * so lib/account.ts needs no changes.
 */

import { createLogger } from "@/agents/_logger"
import { pkceChallenge, signToken } from "@/cloud-functions/_auth/core"
import {
  authConfig,
  cookieHeader,
  isHttps,
  OAUTH_COOKIE,
  OAUTH_MAX_AGE,
  OIDC_SCOPE,
  originOf,
  randomToken,
  redirect,
} from "@/cloud-functions/_auth/config"

export const runtime = "nodejs"

const logger = createLogger("auth-login")

export async function GET(request: Request): Promise<Response> {
  const cfg = authConfig(process.env)
  if (!cfg.enabled) return redirect("/?signin=unavailable")

  try {
    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const challenge = await pkceChallenge(verifier)
    const origin = originOf(request, process.env)
    const redirectUri = `${origin}/auth-callback`

    // The origin travels in the signed cookie so the callback redeems the code
    // against exactly the redirect_uri that was authorized — OAuth requires the
    // two to match, and signing it keeps the browser from changing it in between.
    const oauthCookie = await signToken(
      { state, nonce, verifier, origin, exp: Math.floor(Date.now() / 1000) + OAUTH_MAX_AGE },
      cfg.signingSecret,
    )

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: OIDC_SCOPE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })

    return redirect(`${cfg.authorizeUrl}?${params.toString()}`, [
      cookieHeader(OAUTH_COOKIE, oauthCookie, { maxAge: OAUTH_MAX_AGE, secure: isHttps(request, process.env) }),
    ])
  } catch (e) {
    logger.error("couldn't start sign-in:", e)
    return redirect("/?signin=error")
  }
}
