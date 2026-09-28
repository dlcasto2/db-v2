import { type NextRequest, NextResponse } from "next/server"
import { YTError, browserCookieFrom, videoInfo } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const maxDuration = 60

/** GET /api/youtube/info?id=<video id> -> title, channel and the downloadable formats */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id")?.trim() ?? ""
  try {
    return NextResponse.json(await videoInfo(id, browserCookieFrom(request.headers.get("cookie"))), { headers: { "cache-control": "private, max-age=600" } })
  } catch (error) {
    if (!(error instanceof YTError) || error.status >= 500) console.error("[youtube/info]", id, error)
    const status = error instanceof YTError ? error.status : 502
    const message = error instanceof Error ? error.message : "Couldn't load this video."
    const code = error instanceof YTError ? error.code : undefined
    return NextResponse.json({ error: message, code }, { status })
  }
}
