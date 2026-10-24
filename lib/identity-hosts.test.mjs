// Regression tests for identity-provider detection and the sign-in handoff.
// Zero dependencies: run with `pnpm test` (node --test). Needs Node 22.18+,
// which loads the .ts module directly by stripping its types.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { directIdentityUrl, identityHandoff, isStrictIdentityUrl, STRICT_IDENTITY_HOSTS } from "./identity-hosts.ts"

describe("isStrictIdentityUrl", () => {
  for (const url of [
    "https://accounts.google.com/",
    "https://accounts.google.com/signin/v2/identifier?continue=https%3A%2F%2Fwww.youtube.com",
    "https://myaccount.google.com/",
    "https://myaccount.google.com/security",
    "https://ACCOUNTS.GOOGLE.COM/",
    "https://accounts.google.com./",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://appleid.apple.com/auth/authorize",
  ]) {
    it(`recognizes ${url}`, () => assert.equal(isStrictIdentityUrl(url), true))
  }

  for (const url of [
    "https://youtube.com/",
    "https://www.youtube.com/watch?v=example",
    "https://google.com/search?q=test",
    "https://mail.google.com/",
    "https://example.com/?next=https://accounts.google.com/",
  ]) {
    it(`leaves ordinary browsing alone: ${url}`, () => assert.equal(isStrictIdentityUrl(url), false))
  }

  for (const url of [
    "not a URL",
    "",
    "javascript:alert(1)",
    "https://accounts.google.com.attacker.example/",
    "https://evil-accounts.google.com.example/",
    "https://accounts-google.com/",
  ]) {
    it(`rejects invalid or lookalike: ${JSON.stringify(url)}`, () => assert.equal(isStrictIdentityUrl(url), false))
  }

  it("lists Google Account settings", () => assert.ok(STRICT_IDENTITY_HOSTS.includes("myaccount.google.com")))
})

describe("directIdentityUrl", () => {
  it("offers the bare HTTPS origin of Google Accounts", () =>
    assert.equal(directIdentityUrl("https://accounts.google.com/"), "https://accounts.google.com/"))

  it("offers the bare HTTPS origin of Google Account settings", () =>
    assert.equal(directIdentityUrl("https://myaccount.google.com/security"), "https://myaccount.google.com/"))

  it("drops the redirect target baked in from Devon's origin", () => {
    const blocked =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fdb.edgeone.dev%2Fcb&state=y"
    const direct = directIdentityUrl(blocked)
    assert.equal(direct, "https://accounts.google.com/")
    assert.ok(!direct.includes("redirect_uri"))
    assert.ok(!direct.includes("edgeone"))
  })

  it("normalizes case and a trailing dot", () =>
    assert.equal(directIdentityUrl("https://ACCOUNTS.google.com./x"), "https://accounts.google.com/"))

  it("never returns a proxy URL", () => {
    const direct = directIdentityUrl("https://accounts.google.com/signin")
    assert.ok(!direct.includes("/api/proxy"))
  })

  for (const url of [
    "http://accounts.google.com/",
    "https://www.youtube.com/watch?v=abc",
    "https://accounts.google.com.attacker.example/",
    "not a URL",
  ]) {
    it(`returns null for ${url}`, () => assert.equal(directIdentityUrl(url), null))
  }
})

describe("identityHandoff", () => {
  const idp = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fdb.edgeone.dev%2F"

  it("offers the site the user came from plus a clean provider link", () =>
    assert.deepEqual(identityHandoff(idp, "https://www.youtube.com/watch?v=abc"), {
      idpUrl: idp,
      destinationUrl: "https://www.youtube.com/watch?v=abc",
      directUrl: "https://accounts.google.com/",
    }))

  it("has no destination when the IdP was opened directly", () =>
    assert.equal(identityHandoff(idp, undefined).destinationUrl, null))

  it("never offers a Devon-internal page as the destination", () => {
    assert.equal(identityHandoff(idp, "devon://apps/youtube").destinationUrl, null)
    assert.equal(identityHandoff(idp, "devon://games").destinationUrl, null)
  })

  it("never offers another identity page as the destination", () =>
    assert.equal(identityHandoff(idp, "https://myaccount.google.com/").destinationUrl, null))

  it("never offers a script URL as the destination", () =>
    assert.equal(identityHandoff(idp, "javascript:alert(1)").destinationUrl, null))

  it("never hands back the blocked IdP URL itself", () => {
    const handoff = identityHandoff(idp, null)
    assert.notEqual(handoff.destinationUrl, idp)
    assert.notEqual(handoff.directUrl, idp)
  })

  it("offers nothing to open for a plain-HTTP identity URL", () => {
    const handoff = identityHandoff("http://accounts.google.com/", null)
    assert.equal(handoff.destinationUrl, null)
    assert.equal(handoff.directUrl, null)
  })
})
