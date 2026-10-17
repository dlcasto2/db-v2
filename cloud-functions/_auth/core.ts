/**
 * Core auth primitives for Devon's Google sign-in, shared by the cloud
 * functions and their tests. Everything here is Web-standard (WebCrypto,
 * TextEncoder) so it runs the same on EdgeOne's function runtime and in Node.
 *
 * Nothing here talks to Google or the store; it's pure crypto + encoding so it
 * can be unit-tested without a network or a browser.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeJson(value: unknown): string {
  return base64urlEncode(encoder.encode(JSON.stringify(value)))
}

function decodeJson<T>(text: string): T {
  return JSON.parse(decoder.decode(base64urlDecode(text))) as T
}

// ---------------------------------------------------------------------------
// Random values
// ---------------------------------------------------------------------------

/** A URL-safe random token (default 32 bytes → 43 chars). For state, nonce, PKCE verifier. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return base64urlEncode(buf)
}

// ---------------------------------------------------------------------------
// HMAC-signed tokens (session + the short-lived OAuth state cookie)
// ---------------------------------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data))
  return new Uint8Array(sig)
}

/** Constant-time comparison of two byte arrays */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/**
 * Signs a payload into a compact `<body>.<sig>` token. The body is the JSON,
 * base64url-encoded; the signature is HMAC-SHA256 over the body. Tamper with
 * either and verifySigned rejects it.
 */
export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = encodeJson(payload)
  const sig = base64urlEncode(await hmac(secret, body))
  return `${body}.${sig}`
}

/** Returns the payload if the signature is valid and (when `exp` is set) not expired, else null */
export async function verifyToken<T extends { exp?: number }>(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<T | null> {
  const dot = token.indexOf(".")
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  let expected: Uint8Array
  try {
    expected = await hmac(secret, body)
  } catch {
    return null
  }
  let given: Uint8Array
  try {
    given = base64urlDecode(sig)
  } catch {
    return null
  }
  if (!timingSafeEqual(expected, given)) return null
  let payload: T
  try {
    payload = decodeJson<T>(body)
  } catch {
    return null
  }
  if (typeof payload.exp === "number" && payload.exp <= Math.floor(now / 1000)) return null
  return payload
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636, S256)
// ---------------------------------------------------------------------------

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
  return base64urlEncode(new Uint8Array(digest))
}

// ---------------------------------------------------------------------------
// Google ID token (JWT) claims
// ---------------------------------------------------------------------------

export interface GoogleClaims {
  iss: string
  aud: string
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  nonce?: string
  exp: number
  iat?: number
}

/**
 * Reads the claims out of a Google ID token WITHOUT verifying the RSA
 * signature. Only ever call this on a token fetched by the server directly
 * from Google's token endpoint over TLS (never one that passed through a
 * browser): that server-to-server channel is itself the proof of origin, which
 * is why validateClaims still checks iss / aud / exp / nonce.
 */
export function decodeIdToken(idToken: string): GoogleClaims | null {
  const parts = idToken.split(".")
  if (parts.length !== 3) return null
  try {
    return decodeJson<GoogleClaims>(parts[1])
  } catch {
    return null
  }
}

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"])

export function validateClaims(
  claims: GoogleClaims | null,
  expected: { clientId: string; nonce: string; now?: number },
): { ok: true; claims: GoogleClaims } | { ok: false; reason: string } {
  if (!claims) return { ok: false, reason: "unreadable token" }
  const now = Math.floor((expected.now ?? Date.now()) / 1000)
  if (!GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: "wrong issuer" }
  if (claims.aud !== expected.clientId) return { ok: false, reason: "wrong audience" }
  if (typeof claims.exp !== "number" || claims.exp <= now) return { ok: false, reason: "expired" }
  if (!claims.sub) return { ok: false, reason: "no subject" }
  if (claims.nonce !== expected.nonce) return { ok: false, reason: "nonce mismatch" }
  return { ok: true, claims }
}
