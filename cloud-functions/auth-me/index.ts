/**
 * Who's signed in — EdgeOne Makers Node Function (GET /auth-me).
 *
 * Reads Devon's session cookie and reports the signed-in user (name, email,
 * picture — never any Google token) and whether Google sign-in is configured
 * on this deployment, so the UI can show the right control.
 */

import type { CloudFunctionContext } from "@edgeone/types"
import { authConfig, json, parseCookies, readSession } from "../_auth/config"

export async function onRequestGet(context: CloudFunctionContext): Promise<Response> {
  const cfg = authConfig(context.env)
  const cookies = parseCookies(context.request?.headers.get("cookie"))
  const session = await readSession(cookies, cfg.signingSecret)
  if (session) {
    return json({
      enabled: true,
      signedIn: true,
      user: { sub: session.sub, email: session.email, name: session.name, picture: session.picture },
    })
  }
  return json({ enabled: cfg.enabled, signedIn: false })
}
