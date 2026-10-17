/**
 * Server-side helpers shared by Devon's Google-account cloud functions:
 * reading the OAuth config from the environment, building and reading cookies,
 * small Response helpers, and the per-user sync store.
 *
 * Google accounts are an EdgeOne feature, like Devon AI: these functions read
 * `context.env` and use the Makers store. Set these in the EdgeOne project:
 *   DEVON_GOOGLE_CLIENT_ID      OAuth 2.0 client ID (public)
 *   DEVON_GOOGLE_CLIENT_SECRET  OAuth 2.0 client secret (server-only)
 *   DEVON_AUTH_SECRET           random string used to sign the session cookie
 *                               (optional; falls back to the client secret)
 */

import type { AgentMemory } from "@edgeone/types"
import { randomToken, signToken, verifyToken } from "./core"

type Env = Record<string, string | undefined>
type Store = Omit<AgentMemory, "langgraphCheckpointer" | "langgraphStore">

export const SESSION_COOKIE = "devon_account"
export const OAUTH_COOKIE = "devon_oauth"
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60 // 30 days
export const OAUTH_MAX_AGE = 10 * 60 // 10 minutes

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
export const GOOGLE_SCOPE = "openid email profile"

export interface AuthConfig {
  enabled: boolean
  clientId: string
  clientSecret: string
  /** Key the session cookie is signed with */
  signingSecret: string
}

export function authConfig(env: Env): AuthConfig {
  const clientId = (env.DEVON_GOOGLE_CLIENT_ID || "").trim()
  const clientSecret = (env.DEVON_GOOGLE_CLIENT_SECRET || "").trim()
  const signingSecret = (env.DEVON_AUTH_SECRET || "").trim() || clientSecret
  return { enabled: Boolean(clientId && clientSecret), clientId, clientSecret, signingSecret }
}

// ---------------------------------------------------------------------------
// The session the browser carries (no Google tokens ever reach the browser)
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

/** Devon's own origin for building the OAuth redirect URI (from the request URL) */
export function originOf(request: { url: string }): string {
  return new URL(request.url).origin
}

export function isHttps(request: { url: string }): boolean {
  return new URL(request.url).protocol === "https:"
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
