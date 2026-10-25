// Regression tests for distinguishing "this server can't reach
// googlevideo.com" (DNS/connect failure) from YouTube actually answering and
// refusing. Run with `pnpm test` (node --test). Needs Node 22.18+.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { describeIfUnreachable, UNREACHABLE_PREFIX } from "./youtube-network-error.ts"

function fetchFailed(cause) {
  const e = new TypeError("fetch failed")
  if (cause) e.cause = cause
  return e
}

describe("describeIfUnreachable", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"]) {
    it(`recognizes a DNS/connect failure (${code})`, () => {
      const desc = describeIfUnreachable(fetchFailed({ code, hostname: "rr1---sn-abc.googlevideo.com" }))
      assert.ok(desc?.startsWith(UNREACHABLE_PREFIX))
      assert.match(desc, /rr1---sn-abc\.googlevideo\.com/)
      assert.match(desc, new RegExp(code))
    })
  }

  it("recognizes an unlabeled fetch failure (e.g. through DEVON_YT_PROXY)", () => {
    const desc = describeIfUnreachable(fetchFailed())
    assert.ok(desc?.startsWith(UNREACHABLE_PREFIX))
  })

  it("is not fooled by an unrelated TypeError", () =>
    assert.equal(describeIfUnreachable(new TypeError("fetch failed but actually something else")), null))

  it("ignores an HTTP-level refusal (YouTube actually answered)", () =>
    assert.equal(describeIfUnreachable(new Error("HTTP 403")), null))

  it("ignores YouTube's bot-check message", () =>
    assert.equal(describeIfUnreachable(new Error("Sign in to confirm you're not a bot")), null))

  it("ignores an unrelated cause code", () =>
    assert.equal(describeIfUnreachable(fetchFailed({ code: "CERT_HAS_EXPIRED" })), null))

  it("ignores a non-Error value", () => {
    assert.equal(describeIfUnreachable("fetch failed"), null)
    assert.equal(describeIfUnreachable(null), null)
    assert.equal(describeIfUnreachable(undefined), null)
  })

  it("degrades gracefully without a hostname", () => {
    const desc = describeIfUnreachable(fetchFailed({ code: "ENOTFOUND" }))
    assert.ok(desc?.startsWith(UNREACHABLE_PREFIX))
    assert.doesNotMatch(desc, /undefined/)
  })
})

describe("the resolve()-loop classification this enables", () => {
  // Mirrors the check in lib/youtube-server.ts's resolve(): once every
  // client's reason is a describeIfUnreachable() string, that batch is
  // treated as "server can't reach googlevideo.com", not "YouTube refused
  // it" (bot-check) or a per-video problem (stream-unavailable).
  function allUnreachable(reasons) {
    return reasons.length > 0 && reasons.every((r) => r.startsWith(UNREACHABLE_PREFIX))
  }

  it("classifies a batch where every client hit the same DNS failure", () => {
    const reasons = ["TV_EMBEDDED", "WEB_EMBEDDED", "TV_SIMPLY"].map(
      () => describeIfUnreachable(fetchFailed({ code: "ENOTFOUND", hostname: "googlevideo.com" })),
    )
    assert.ok(allUnreachable(reasons))
  })

  it("does not classify a mixed batch (bot check plus one network blip) as unreachable", () => {
    const reasons = [
      "Sign in to confirm you're not a bot",
      describeIfUnreachable(fetchFailed({ code: "ENOTFOUND" })),
    ]
    assert.ok(!allUnreachable(reasons))
  })

  it("does not classify an empty batch as unreachable", () => assert.ok(!allUnreachable([])))
})
