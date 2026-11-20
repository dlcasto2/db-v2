import { type NextRequest, NextResponse } from "next/server"
import { YTError, channelVideos, channelVideosMore, corsPreflight, withCors } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const maxDuration = 30

/**
 * GET /api/youtube/channel?c=<channel>             -> { channel, items, next }: the latest uploads
 * GET /api/youtube/channel?next=<token>[&owner=…]  -> { items, next }: the next page
 *
 * <channel> is a UC… channel ID, an @handle, a youtube.com channel link or a
 * plain name (the top match in a channel search). Items have the same shape as
 * /api/youtube/search results. Readable from other sites (see DEVON_YT_CORS).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const c = params.get("c")?.trim() ?? ""
  const next = params.get("next") ?? ""
  try {
    if (next) {
      const owner = (params.get("owner") ?? "").slice(0, 200)
      return withCors(request, NextResponse.json(await channelVideosMore(next, owner)))
    }
    if (!c) return withCors(request, NextResponse.json({ error: "Type a channel to load." }, { status: 400 }))
    return withCors(
      request,
      NextResponse.json(await channelVideos(c.slice(0, 300)), { headers: { "cache-control": "private, max-age=300" } }),
    )
  } catch (error) {
    if (!(error instanceof YTError) || error.status >= 500) console.error("[youtube/channel]", c || "(next page)", error)
    const status = error instanceof YTError ? error.status : 502
    const message = error instanceof YTError ? error.message : "Couldn't load this channel from YouTube. Try again in a moment."
    const code = error instanceof YTError ? error.code : undefined
    return withCors(request, NextResponse.json({ error: message, code }, { status }))
  }
}

export function OPTIONS(request: NextRequest) {
  return corsPreflight(request)
}
