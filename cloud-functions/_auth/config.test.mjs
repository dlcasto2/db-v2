// Regression tests for Devon's account config helpers — the pieces shared,
// unmodified, between the EdgeOne cloud functions (cloud-functions/auth-*)
// and the Vercel-native routes (app/auth-*/route.ts, app/account-sync/route.ts).
// Run with `pnpm test` (node --test). Needs Node 22.18+.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  accountNamespace,
  authConfig,
  clearCookieHeader,
  cookieHeader,
  isHttps,
  OAUTH_COOKIE,
  parseCookies,
  publicOrigin,
  readSyncRaw,
  SESSION_COOKIE,
  writeSyncRaw,
} from "./config.ts"

describe("authConfig", () => {
  it("is disabled with nothing set", () => assert.equal(authConfig({}).enabled, false))

  it("is disabled with only some of the three required vars", () =>
    assert.equal(
      authConfig({ DEVON_AUTH0_DOMAIN: "x.auth0.com", DEVON_AUTH0_CLIENT_ID: "id" }).enabled,
      false,
    ))

  it("is enabled once domain, client id and secret are all set", () => {
    const cfg = authConfig({
      DEVON_AUTH0_DOMAIN: "https://my-tenant.us.auth0.com/",
      DEVON_AUTH0_CLIENT_ID: "abc123",
      DEVON_AUTH0_CLIENT_SECRET: "shh",
    })
    assert.equal(cfg.enabled, true)
    // scheme and trailing slash stripped
    assert.equal(cfg.issuer, "https://my-tenant.us.auth0.com/")
    assert.equal(cfg.authorizeUrl, "https://my-tenant.us.auth0.com/authorize")
    assert.equal(cfg.tokenUrl, "https://my-tenant.us.auth0.com/oauth/token")
  })

  it("signs with DEVON_AUTH_SECRET when set, else falls back to the client secret", () => {
    const withSecret = authConfig({
      DEVON_AUTH0_DOMAIN: "x.auth0.com",
      DEVON_AUTH0_CLIENT_ID: "id",
      DEVON_AUTH0_CLIENT_SECRET: "client-secret",
      DEVON_AUTH_SECRET: "own-secret",
    })
    assert.equal(withSecret.signingSecret, "own-secret")

    const withoutSecret = authConfig({
      DEVON_AUTH0_DOMAIN: "x.auth0.com",
      DEVON_AUTH0_CLIENT_ID: "id",
      DEVON_AUTH0_CLIENT_SECRET: "client-secret",
    })
    assert.equal(withoutSecret.signingSecret, "client-secret")
  })

  it("accepts a plain process.env-shaped object (the Vercel routes' call)", () => {
    // Not a real mutation of process.env — just proof authConfig doesn't need
    // an EdgeOne-specific env shape.
    const fakeProcessEnv = { ...process.env, DEVON_AUTH0_DOMAIN: "", DEVON_AUTH0_CLIENT_ID: "", DEVON_AUTH0_CLIENT_SECRET: "" }
    assert.equal(authConfig(fakeProcessEnv).enabled, false)
  })
})

describe("parseCookies / cookieHeader / clearCookieHeader", () => {
  it("round-trips a cookie value", () => {
    const header = cookieHeader(SESSION_COOKIE, "tok123", { maxAge: 60, secure: true })
    assert.match(header, /^devon_account=tok123;/)
    assert.match(header, /HttpOnly/)
    assert.match(header, /Secure/)
    const cookieLine = header.split(";")[0]
    assert.deepEqual(parseCookies(cookieLine), { devon_account: "tok123" })
  })

  it("parses multiple cookies from a real Cookie header", () => {
    assert.deepEqual(parseCookies(`${OAUTH_COOKIE}=a; ${SESSION_COOKIE}=b`), {
      [OAUTH_COOKIE]: "a",
      [SESSION_COOKIE]: "b",
    })
  })

  it("handles a missing Cookie header", () => assert.deepEqual(parseCookies(null), {}))

  it("omits Secure over plain http", () => assert.ok(!clearCookieHeader(SESSION_COOKIE, false).includes("Secure")))
})

describe("publicOrigin / isHttps", () => {
  const req = (url, headers = {}) => ({
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  })

  it("prefers DEVON_PUBLIC_ORIGIN when set", () =>
    assert.equal(
      publicOrigin(req("http://internal:8080/auth-login"), { DEVON_PUBLIC_ORIGIN: "https://browser.lovedub.net" }),
      "https://browser.lovedub.net",
    ))

  it("falls back to the browser-stated ?origin= on /auth-login", () =>
    assert.equal(
      publicOrigin(req("http://internal:8080/auth-login?origin=https%3A%2F%2Fdb-v2.vercel.app")),
      "https://db-v2.vercel.app",
    ))

  it("uses a Vercel-style Host header when nothing else is given", () =>
    assert.equal(
      publicOrigin(req("http://127.0.0.1/auth-me", { "x-forwarded-proto": "https", host: "browser.lovedub.net" })),
      "https://browser.lovedub.net",
    ))

  it("never trusts an EdgeOne-internal host reported as the request host", () =>
    assert.equal(
      publicOrigin(req("https://pages-pro-0000.pages-scf-ab-pro.qcloudteo.com/auth-me")),
      "https://pages-pro-0000.pages-scf-ab-pro.qcloudteo.com",
    ))

  it("reports https for a Vercel request even without an explicit scheme header", () =>
    assert.equal(isHttps(req("http://x/auth-me", { host: "browser.lovedub.net" })), true))

  it("reports http only for a local address", () =>
    assert.equal(isHttps(req("http://localhost:3000/auth-me")), false))
})

describe("accountNamespace", () => {
  it("is stable for the same subject", async () => {
    const a = await accountNamespace("google-oauth2|123")
    const b = await accountNamespace("google-oauth2|123")
    assert.equal(a, b)
    assert.match(a, /^acct-[0-9a-f]{40}$/)
  })

  it("differs for different subjects", async () => {
    const a = await accountNamespace("sub-a")
    const b = await accountNamespace("sub-b")
    assert.notEqual(a, b)
  })
})

describe("readSyncRaw / writeSyncRaw against a minimal store", () => {
  // Deliberately NOT EdgeOne's AgentMemory — a tiny stand-in with only the
  // three methods the narrowed Store type requires (see config.ts), the same
  // shape lib/devon-ai/server/store.ts's createAiStore() exposes on Vercel.
  function fakeStore() {
    const byConversation = new Map()
    return {
      async appendMessage({ conversationId, content }) {
        const list = byConversation.get(conversationId) ?? []
        list.unshift({ content })
        byConversation.set(conversationId, list)
        return "msg-id"
      },
      async getMessages({ conversationId, limit = 50 }) {
        return (byConversation.get(conversationId) ?? []).slice(0, limit)
      },
      async clearMessages({ conversationId }) {
        byConversation.delete(conversationId)
      },
    }
  }

  it("reads back what it wrote", async () => {
    const store = fakeStore()
    const ns = await accountNamespace("sub-x")
    await writeSyncRaw(store, ns, { bookmarks: [{ id: "1" }] })
    const read = await readSyncRaw(store, ns)
    assert.deepEqual(read, { bookmarks: [{ id: "1" }] })
  })

  it("replaces rather than accumulates on a second write", async () => {
    const store = fakeStore()
    const ns = await accountNamespace("sub-y")
    await writeSyncRaw(store, ns, { bookmarks: [{ id: "1" }] })
    await writeSyncRaw(store, ns, { bookmarks: [{ id: "2" }] })
    assert.deepEqual(await readSyncRaw(store, ns), { bookmarks: [{ id: "2" }] })
  })

  it("reads back empty for a namespace nothing was ever written to", async () => {
    const store = fakeStore()
    assert.deepEqual(await readSyncRaw(store, "acct-never-written"), {})
  })
})
