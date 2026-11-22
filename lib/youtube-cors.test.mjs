// Tests for DEVON_YT_CORS (cross-origin access to the YouTube API).
// Run with `pnpm test` (node --test). Needs Node 22.18+.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { allowedOrigin, corsHeaders, describeCors, parseCorsSetting } from "./youtube-cors.ts"

describe("parseCorsSetting", () => {
  it("defaults to any site", () => {
    for (const v of [undefined, null, "", "  ", "*", '"*"']) assert.deepEqual(parseCorsSetting(v), { kind: "any" })
  })
  it("can be switched off", () => {
    for (const v of ["off", "OFF", "none", "false", "0", "no"]) assert.deepEqual(parseCorsSetting(v), { kind: "off" })
  })
  it("reads a list of origins, wildcards and trailing slashes included", () => {
    const p = parseCorsSetting("https://coreview.lovable.app/, https://*.lovable.app , http://localhost:5173")
    assert.equal(p.kind, "list")
    assert.deepEqual(describeCors(p), ["https://coreview.lovable.app", "http://localhost:5173", "https://*.lovable.app"])
  })
  it("treats a list with nothing usable as off, not as any", () => {
    assert.deepEqual(parseCorsSetting("not a url, ftp://x.com"), { kind: "off" })
  })
  it("a * inside a list means any", () => {
    assert.deepEqual(parseCorsSetting("https://a.com, *"), { kind: "any" })
  })
})

describe("allowedOrigin", () => {
  const list = parseCorsSetting("https://coreview.lovable.app, https://*.lovable.app")
  it("answers * for any site, even without an Origin header", () => {
    assert.equal(allowedOrigin(parseCorsSetting(""), "https://evil.example"), "*")
    assert.equal(allowedOrigin(parseCorsSetting(""), null), "*")
  })
  it("answers nothing when off", () => {
    assert.equal(allowedOrigin(parseCorsSetting("off"), "https://coreview.lovable.app"), null)
  })
  it("echoes a listed origin", () => {
    assert.equal(allowedOrigin(list, "https://coreview.lovable.app"), "https://coreview.lovable.app")
  })
  it("matches wildcard subdomains but not the bare domain or look-alikes", () => {
    assert.equal(
      allowedOrigin(list, "https://id-preview--7b7071f6-a225-4885-9322-119f04dd8965.lovable.app"),
      "https://id-preview--7b7071f6-a225-4885-9322-119f04dd8965.lovable.app",
    )
    assert.equal(allowedOrigin(parseCorsSetting("https://*.lovable.app"), "https://lovable.app"), null)
    assert.equal(allowedOrigin(list, "https://lovable.app.evil.com"), null)
    assert.equal(allowedOrigin(list, "https://evillovable.app"), null)
    assert.equal(allowedOrigin(list, "http://x.lovable.app"), null)
  })
  it("refuses a missing or malformed Origin when a list is set", () => {
    assert.equal(allowedOrigin(list, null), null)
    assert.equal(allowedOrigin(list, "null"), null)
  })
})

describe("corsHeaders", () => {
  it("never allows credentials", () => {
    for (const setting of ["", "https://a.com"]) {
      const h = corsHeaders(parseCorsSetting(setting), "https://a.com", true)
      assert.equal(h["Access-Control-Allow-Credentials"], undefined)
    }
  })
  it("adds preflight answers only for preflights", () => {
    const any = parseCorsSetting("")
    assert.equal(corsHeaders(any, "https://a.com")["Access-Control-Allow-Methods"], undefined)
    const pre = corsHeaders(any, "https://a.com", true)
    assert.equal(pre["Access-Control-Allow-Methods"], "GET, HEAD, OPTIONS")
    assert.equal(pre["Access-Control-Allow-Headers"], "range")
  })
  it("exposes the range headers ranged media fetches need", () => {
    assert.match(corsHeaders(parseCorsSetting(""), "https://a.com")["Access-Control-Expose-Headers"], /content-range/)
  })
  it("varies on Origin with a list, even when refusing", () => {
    const list = parseCorsSetting("https://a.com")
    assert.deepEqual(corsHeaders(list, "https://b.com"), { Vary: "Origin" })
    assert.equal(corsHeaders(list, "https://a.com").Vary, "Origin")
    assert.equal(corsHeaders(parseCorsSetting(""), "https://a.com").Vary, undefined)
  })
  it("adds nothing when off", () => {
    assert.deepEqual(corsHeaders(parseCorsSetting("off"), "https://a.com", true), {})
  })
})
