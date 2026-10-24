/**
 * Server-side helpers shared by Devon's account cloud functions: reading the
 * OIDC config from the environment, building and reading cookies, small
 * Response helpers, and the per-user sync store.
 *
 * Sign-in goes through Auth0 (an OIDC provider), which can front Google and
 * other logins. Accounts are an EdgeOne feature, like Devon AI: these
 * functions read `context.env` and use the Makers store. Set in the EdgeOne
 * project:
 *   DEVON_AUTH0_DOMAIN         the tenant domain, e.g. your-tenant.us.auth0.com
 *   DEVON_AUTH0_CLIENT_ID      the application's client ID (public)
 *   DEVON_AUTH0_CLIENT_SECRET  the application's client secret (server-only)
 *   DEVON_AUTH_SECRET          random string used to sign the session cookie
 *                              (optional; falls back to the client secret)
 *   DEVON_PUBLIC_ORIGIN        the address browsers use, e.g.
 *                              https://devon.example.com. Set this on EdgeOne:
 *                              the runtime reports an internal host, which
 *                              would make the OAuth redirect URI wrong.
 */

import type { AgentMemory } from "@edgeone/types"
// ".js" (not ".ts"): resolves to core.ts under TS's bundler/nodenext rules,
// and — unlike a bare "./core" — is also resolvable by Node's own ESM loader
// when this file is run directly, e.g. by `node --test` (see config.test.mjs).
import { randomToken, signToken, verifyToken } from "./core.ts"

type Env = Record<string, string | undefined>
/**
 * Only the three message methods the sync store actually calls. EdgeOne's
 * real `context.agent.store` (a full AgentMemory) satisfies this trivially;
 * narrowing to just these lets Vercel's Redis-backed store
 * (lib/devon-ai/server/store.ts's createAiStore(), written against the same
 * Pick<AgentMemory, ...> convention as agents/_mailbox.ts and friends) stand
 * in for it too, with no change to readSyncRaw/writeSyncRaw themselves — see
 * app/account-sync/route.ts.
 */
type Store = Pick<AgentMemory, "getMessages" | "appendMessage" | "clearMessages">

export const SESSION_COOKIE = "devon_account"
export const OAUTH_COOKIE = "devon_oauth"
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days
export const OAUTH_MAX_AGE = 10 * 60 // 10 minutes

/** OpenID Connect scopes; Auth0 returns the profile claims Devon shows */
export const OIDC_SCOPE = "openid profile email"

export interface AuthConfig {
  enabled: boolean
  clientId: string
  clientSecret: string
  /** The Auth0 (OIDC) endpoints, derived from the tenant domain */
  issuer: string
  authorizeUrl: string
  tokenUrl: string
  /** Key the session cookie is signed with */
  signingSecret: string
}

/** Strip a tenant domain down to a bare host (no scheme, no trailing slash/path) */
function cleanDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
}

export function authConfig(env: Env): AuthConfig {
  const domain = cleanDomain(env.DEVON_AUTH0_DOMAIN || "")
  const clientId = (env.DEVON_AUTH0_CLIENT_ID || "").trim()
  const clientSecret = (env.DEVON_AUTH0_CLIENT_SECRET || "").trim()
  const signingSecret = (env.DEVON_AUTH_SECRET || "").trim() || clientSecret
  return {
    enabled: Boolean(domain && clientId && clientSecret),
    clientId,
    clientSecret,
    issuer: domain ? `https://${domain}/` : "",
    authorizeUrl: domain ? `https://${domain}/authorize` : "",
    tokenUrl: domain ? `https://${domain}/oauth/token` : "",
    signingSecret,
  }
}

// ---------------------------------------------------------------------------
// The session the browser carries (no provider tokens ever reach the browser)
// ---------------------------------------------------------------------------

export interface AccountSession {
  sub: string
  email?: string
  name?: string
  picture?: string
  exp: number
}

export async function makeSessionToken(
  user: { sub: string; email?: string; name?: string; picture?: string },
  secret: string,
  now = Date.now(),
): Promise<string> {
  const payload: AccountSession = {
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture,
    exp: Math.floor(now / 1000) + SESSION_MAX_AGE,
  }
  return signToken(payload as unknown as Record<string, unknown>, secret)
}

export async function readSession(
  cookies: Record<string, string>,
  secret: string,
  now = Date.now(),
): Promise<AccountSession | null> {
  const token = cookies[SESSION_COOKIE]
  if (!token) return null
  return verifyToken<AccountSession>(token, secret, now)
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function cookieHeader(
  name: string,
  value: string,
  opts: { maxAge: number; secure: boolean; httpOnly?: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${opts.maxAge}`,
    "SameSite=Lax",
    opts.httpOnly === false ? "" : "HttpOnly",
    opts.secure ? "Secure" : "",
  ]
  return parts.filter(Boolean).join("; ")
}

export function clearCookieHeader(name: string, secure: boolean): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`
}

/** Parse a Cookie header into a map (EdgeOne also offers request.cookies, but this keeps it testable) */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header || "").split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name) out[name] = part.slice(eq + 1).trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" } as const

export function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers(JSON_HEADERS)
  for (const c of cookies) headers.append("Set-Cookie", c)
  return new Response(JSON.stringify(data), { status, headers })
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" })
  for (const c of cookies) headers.append("Set-Cookie", c)
  return new Response(null, { status: 302, headers })
}

/**
 * Devon's own origin as the BROWSER sees it, e.g. https://devon.example.com.
 *
 * EdgeOne runs these functions behind its CDN, and the runtime reports the
 * internal function host in `request.url` (something like
 * http://pages-pro-0000.pages-scf-ab-pro.qcloudteo.com). Building the OAuth
 * redirect URI from that sends Auth0 an address that isn't the one registered
 * on the application — and isn't reachable — so sign-in fails with a callback
 * mismatch. The public origin is resolved instead, in order:
 *
 *   1. DEVON_PUBLIC_ORIGIN, if set (exact and deployment-specific)
 *   2. the ?origin= the Devon page states for itself when it sends you to
 *      /auth-login (EdgeOne exposes the public host nowhere else)
 *   3. the X-Forwarded-Host / X-Forwarded-Proto headers a CDN may add
 *   4. the Host header, when it isn't one of the internal names
 *   5. whatever `request.url` says, as a last resort
 *
 * (2) is stated by the browser, so it is not trusted for anything that could
 * be abused. It is used for ONE thing: the redirect_uri handed to Auth0, which
 * Auth0 itself checks against the application's Allowed Callback URLs — a made
 * up value is refused there rather than followed. Nothing here is ever used to
 * build a Location header: every redirect Devon sends back to the visitor is
 * relative, so there is no origin for an attacker to point somewhere else.
 */

type HeaderBag = { get(name: string): string | null }

/** Internal hosts the platform uses between its CDN and the function */
const INTERNAL_HOST = /(^|\.)qcloudteo\.com$|(^|\.)pages-scf|(^|\.)scf\.tencentcs\.com$|^0\.0\.0\.0|^\[?::\]?$/i

const HOST_SHAPE = /^([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?$|^\[[0-9a-f:.]+\](:\d{1,5})?$/i

function firstValue(raw: string | null | undefined): string {
  return (raw || "").split(",")[0].trim()
}

function isLocal(host: string): boolean {
  const name = host.split(":")[0].toLowerCase()
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]"
}

/** A usable http(s) origin, or "" — used for both the env override and ?origin= */
function readOrigin(raw: string | null | undefined): string {
  const value = (raw || "").trim()
  if (!value) return ""
  try {
    const u = new URL(value)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    if (!HOST_SHAPE.test(u.host)) return ""
    return u.origin
  } catch {
    return ""
  }
}

export function publicOrigin(request: { url: string; headers?: HeaderBag }, env: Env = {}): string {
  const explicit = readOrigin(env.DEVON_PUBLIC_ORIGIN)
  if (explicit) return explicit

  const fromUrlEarly = new URL(request.url)
  const stated = readOrigin(fromUrlEarly.searchParams.get("origin"))
  if (stated) return stated

  const headers = request.headers
  const fromUrl = new URL(request.url)
  const forwardedHost = firstValue(headers?.get("x-forwarded-host"))
  const hostHeader = firstValue(headers?.get("host"))
  const candidate = [forwardedHost, hostHeader].find((h) => h && HOST_SHAPE.test(h) && !INTERNAL_HOST.test(h))
  const host = candidate || fromUrl.host

  const forwardedProto = firstValue(headers?.get("x-forwarded-proto")).toLowerCase()
  const protocol = forwardedProto
    ? `${forwardedProto}:`
    : candidate
      ? isLocal(host)
        ? "http:"
        : "https:" // a public host reached through the CDN is served over https
      : fromUrl.protocol

  return `${protocol}//${host}`
}

/** Devon's own origin for building the OAuth redirect URI */
export function originOf(request: { url: string; headers?: HeaderBag }, env: Env = {}): string {
  return publicOrigin(request, env)
}

/**
 * Whether cookies should carry Secure. True for anything but a local address:
 * the runtime can report plain http for an internal hop even though the
 * visitor reached Devon over https.
 */
export function isHttps(request: { url: string; headers?: HeaderBag }, env: Env = {}): boolean {
  const origin = publicOrigin(request, env)
  if (origin.startsWith("https:")) return true
  try {
    return !isLocal(new URL(origin).host)
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Per-user sync store
// ---------------------------------------------------------------------------

/**
 * The store conversation that holds one account's synced data. It's a SHA-256
 * of the Google subject, so it can't be guessed and never exposes the id. The
 * `acct-` prefix is on the AI routes' reserved list, so they refuse it.
 */
export async function accountNamespace(sub: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`devon-account:${sub}`))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `acct-${hex.slice(0, 40)}`
}

/** Reads the latest synced blob for a namespace (empty object if none / on error) */
export async function readSyncRaw(store: Store, namespace: string): Promise<unknown> {
  try {
    const messages = await store.getMessages({ conversationId: namespace, limit: 1, order: "desc" })
    const content = messages[0]?.content
    const text = typeof content === "string" ? content : Array.isArray(content) ? "" : ""
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

/** Replaces the stored blob for a namespace with `data` */
export async function writeSyncRaw(store: Store, namespace: string, data: unknown): Promise<void> {
  // Keep only the newest copy so the conversation can't grow unbounded
  try {
    await store.clearMessages({ conversationId: namespace })
  } catch {
    // a runtime without clearMessages just keeps appending; reads take the newest
  }
  await store.appendMessage({ conversationId: namespace, role: "user", content: JSON.stringify(data) })
}

export { randomToken }
