import { type NextRequest, NextResponse } from "next/server"
import { search, searchMore, suggestions } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const maxDuration = 30

/**
 * GET /api/youtube/search?q=cats         -> first page of video results
 * GET /api/youtube/search?next=<token>   -> the next page
 * GET /api/youtube/search?suggest=ca     -> search suggestions
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const q = params.get("q")?.trim() ?? ""
  const next = params.get("next") ?? ""
  const suggest = params.get("suggest")?.trim() ?? ""
  try {
    if (suggest) {
      return NextResponse.json({ suggestions: (await suggestions(suggest.slice(0, 200))).slice(0, 8) })
    }
    if (next) return NextResponse.json(await searchMore(next))
    if (!q) return NextResponse.json({ error: "Type something to search for." }, { status: 400 })
    return NextResponse.json(await search(q.slice(0, 200)), {
      headers: { "cache-control": "private, max-age=300" },
    })
  } catch (error) {
    console.error("[youtube/search]", error)
    return NextResponse.json({ error: "YouTube search failed. Try again in a moment." }, { status: 502 })
  }
}
