/**
 * Start sign-in — EdgeOne Makers Node Function (GET /auth-login).
 *
 * Generates the CSRF state, the OpenID nonce and a PKCE verifier, stashes them
 * in a short-lived signed HttpOnly cookie, and sends the browser to Auth0's
 * Universal Login (which can offer Google and other logins). The verifier never
 * reaches JavaScript, so the code it protects can only be redeemed by the
 * callback on this same server.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { createLogger } from "../_logger"
import { pkceChallenge, signToken } from "../_auth/core"
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
} from "../_auth/config"

const logger = createLogger("auth-login")

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const request = context.request!
  const cfg = authConfig(context.env)
  if (!cfg.enabled) return redirect("/?signin=unavailable")

  try {
    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const challenge = await pkceChallenge(verifier)
    const origin = originOf(request, context.env)
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
      cookieHeader(OAUTH_COOKIE, oauthCookie, { maxAge: OAUTH_MAX_AGE, secure: isHttps(request, context.env) }),
    ])
  } catch (e) {
    logger.error("couldn't start sign-in:", e)
    return redirect("/?signin=error")
  }
}
