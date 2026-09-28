import { type NextRequest, NextResponse } from "next/server"
import { CHUNK_SIZE, VIDEO_ID_RE, YTError, browserCookieFrom, streamSlice } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * GET /api/youtube/stream?id=<video>&itag=<format>[&c=<client>][&dl=<file name>]
 *
 * Always answers with at most CHUNK_SIZE bytes (206 Partial Content). Honors a
 * Range header, so <video src> can play and seek, and the downloader fetches the
 * file slice by slice.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const id = params.get("id") ?? ""
  const itag = Number(params.get("itag"))
  const client = params.get("c") ?? undefined
  const dl = params.get("dl")
  if (!VIDEO_ID_RE.test(id) || !Number.isInteger(itag) || itag <= 0) {
    return NextResponse.json({ error: "Bad video or format." }, { status: 400 })
  }

  let start = 0
  let end: number | null = null
  const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && range[1]) {
    start = Number(range[1])
    if (range[2]) end = Number(range[2])
  } else if (params.get("start")) {
    start = Math.max(0, Number(params.get("start")) || 0)
  }

  try {
    const slice = await streamSlice(id, itag, start, end, client, request.signal, browserCookieFrom(request.headers.get("cookie")))
    const headers = new Headers({
      "content-type": slice.mime,
      "content-length": String(slice.end - slice.start + 1),
      "content-range": `bytes ${slice.start}-${slice.end}/${slice.total ?? "*"}`,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-devon-chunk-size": String(CHUNK_SIZE),
      // Tells the host/CDN not to re-compress video bytes
      "content-encoding": "identity",
    })
    if (dl) headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`)
    return new Response(slice.body, { status: 206, headers })
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    if (!(error instanceof YTError) || error.status >= 500) console.error("[youtube/stream]", id, itag, error)
    const status = error instanceof YTError ? error.status : 502
    const message = error instanceof Error ? error.message : "Stream failed."
    return NextResponse.json({ error: message }, { status })
  }
}
