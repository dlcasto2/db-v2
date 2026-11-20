// Tests for the Referer the proxy sends when a page load names its embedding
// page with ref= (YouTube's embed answers Error 153 without one).
// Zero dependencies: run with `pnpm test` (node --test). Needs Node 22.18+,
// which loads the .ts module directly by stripping its types.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { refererFromRef } from "./proxy-referer.ts"

describe("refererFromRef", () => {
  it("passes an http(s) page through", () => {
    assert.equal(refererFromRef("https://db-v2.netlify.app/"), "https://db-v2.netlify.app/")
    assert.equal(
      refererFromRef("https://id-preview--7b7071f6.lovable.app/channel?x=1"),
      "https://id-preview--7b7071f6.lovable.app/channel?x=1",
    )
    assert.equal(refererFromRef("http://localhost:3000/"), "http://localhost:3000/")
  })

  it("drops the fragment, like a browser", () => {
    assert.equal(refererFromRef("https://example.com/page#top"), "https://example.com/page")
  })

  it("normalizes a bare origin to have a path", () => {
    assert.equal(refererFromRef("https://example.com"), "https://example.com/")
  })

  it("sends nothing for a missing, malformed or non-web ref", () => {
    for (const ref of [null, undefined, "", "not a url", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "devon://apps/youtube"]) {
      assert.equal(refererFromRef(ref), null, String(ref))
    }
  })
})
