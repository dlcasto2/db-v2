/**
 * Start Google sign-in — EdgeOne Makers Node Function (GET /auth-google-start).
 *
 * Generates the CSRF state, the OpenID nonce and a PKCE verifier, stashes them
 * in a short-lived signed HttpOnly cookie, and sends the browser to Google's
 * consent screen. The verifier never reaches JavaScript, so the code it
 * protects can only be redeemed by the callback on this same server.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"
import { pkceChallenge, signToken } from "../_auth/core"
import {
  authConfig,
  cookieHeader,
  GOOGLE_AUTH_URL,
  GOOGLE_SCOPE,
  isHttps,
  OAUTH_COOKIE,
  OAUTH_MAX_AGE,
  originOf,
  randomToken,
  redirect,
} from "../_auth/config"

const logger = createLogger("auth-google-start")

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const request = context.request!
  const cfg = authConfig(context.env)
  if (!cfg.enabled) return redirect(`${originOf(request)}/?signin=unavailable`)

  try {
    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const challenge = await pkceChallenge(verifier)
    const redirectUri = `${originOf(request)}/auth-google-callback`

    const oauthCookie = await signToken(
      { state, nonce, verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_MAX_AGE },
      cfg.signingSecret,
    )

    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    })

    return redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, [
      cookieHeader(OAUTH_COOKIE, oauthCookie, { maxAge: OAUTH_MAX_AGE, secure: isHttps(request) }),
    ])
  } catch (e) {
    logger.error("couldn't start sign-in:", e)
    return redirect(`${originOf(request)}/?signin=error`)
  }
}
