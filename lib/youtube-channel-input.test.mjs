// Tests for reading what someone typed into a channel box.
// Run with `pnpm test` (node --test). Needs Node 22.18+.
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { parseChannelInput } from "./youtube-channel-input.ts"

const ID = "UCzEy7pi3B7TIS9cn_sdKK9A"

describe("parseChannelInput", () => {
  it("takes a channel ID as is", () => {
    assert.deepEqual(parseChannelInput(` ${ID} `), { kind: "id", id: ID })
  })
  it("resolves an @handle exactly", () => {
    assert.deepEqual(parseChannelInput("@GrayStillPlays"), { kind: "url", url: "https://www.youtube.com/@GrayStillPlays" })
    assert.deepEqual(parseChannelInput("@GrayStillPlays/videos"), { kind: "url", url: "https://www.youtube.com/@GrayStillPlays" })
    assert.equal(parseChannelInput("@"), null)
  })
  it("tries a bare word as a handle, then a search", () => {
    assert.deepEqual(parseChannelInput("graystillplay"), {
      kind: "handle",
      url: "https://www.youtube.com/@graystillplay",
      query: "graystillplay",
    })
  })
  it("searches for names with spaces", () => {
    assert.deepEqual(parseChannelInput("gray still plays"), { kind: "search", query: "gray still plays" })
  })
  it("reads youtube.com channel links", () => {
    assert.deepEqual(parseChannelInput("https://www.youtube.com/@GrayStillPlays/videos?view=0"), {
      kind: "url",
      url: "https://www.youtube.com/@GrayStillPlays",
    })
    assert.deepEqual(parseChannelInput(`youtube.com/channel/${ID}`), { kind: "id", id: ID })
    assert.deepEqual(parseChannelInput("https://m.youtube.com/c/SomeName"), { kind: "url", url: "https://www.youtube.com/c/SomeName" })
    assert.deepEqual(parseChannelInput("https://www.youtube.com/user/someone"), { kind: "url", url: "https://www.youtube.com/user/someone" })
    assert.deepEqual(parseChannelInput("https://www.youtube.com/LegacyName"), { kind: "url", url: "https://www.youtube.com/LegacyName" })
  })
  it("keeps non-Latin handles intact", () => {
    assert.deepEqual(parseChannelInput("https://www.youtube.com/@%E3%81%B2%E3%82%8D"), {
      kind: "url",
      url: "https://www.youtube.com/@%E3%81%B2%E3%82%8D",
    })
  })
  it("refuses links that aren't channels or aren't YouTube", () => {
    assert.equal(parseChannelInput("https://www.youtube.com/watch?v=5pIXL5dPuHg"), null)
    assert.equal(parseChannelInput("https://www.youtube.com/shorts/5pIXL5dPuHg"), null)
    assert.equal(parseChannelInput("https://www.youtube.com/channel/not-an-id"), null)
    assert.equal(parseChannelInput("https://example.com/@someone"), null)
    assert.equal(parseChannelInput("https://youtube.com.evil.com/@someone"), null)
    assert.equal(parseChannelInput("   "), null)
  })
})
