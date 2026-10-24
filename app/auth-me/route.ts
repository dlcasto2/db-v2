/**
 * Who's signed in — Vercel-native route, GET /auth-me.
 *
 * Vercel-native equivalent of cloud-functions/auth-me/index.ts, against
 * process.env instead of EdgeOne's context.env. The OIDC/session helpers in
 * cloud-functions/_auth/ are plain functions (Web Request/Headers in, no
 * EdgeOne-specific calls), so they're reused unchanged. Same request/response
 * shape, so lib/account.ts needs no changes.
 */

import { authConfig, json, parseCookies, publicOrigin, readSession } from "@/cloud-functions/_auth/config"

export const runtime = "nodejs"

export async function GET(request: Request): Promise<Response> {
  const cfg = authConfig(process.env)
  const origin = publicOrigin(request, process.env)
  const cookies = parseCookies(request.headers.get("cookie"))
  const session = await readSession(cookies, cfg.signingSecret)
  if (session) {
    return json({
      enabled: true,
      origin,
      signedIn: true,
      user: { sub: session.sub, email: session.email, name: session.name, picture: session.picture },
    })
  }
  return json({ enabled: cfg.enabled, origin, signedIn: false })
}
