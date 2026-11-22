import { type NextRequest, NextResponse } from "next/server"
import { corsPreflight, search, searchMore, suggestions, withCors } from "@/lib/youtube-server"
import { dataApiSearch, isDataApiToken, dataApiConfigured } from "@/lib/youtube-data-api"

export const runtime = "nodejs"
export const maxDuration = 30

/** Official Data API is preferred when configured; youtubei.js remains a legacy fallback. */
const useDataApi = () => dataApiConfigured() && process.env.DEVON_YT_SEARCH_PROVIDER !== "innertube"

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const q = params.get("q")?.trim() ?? ""
  const next = params.get("next") ?? ""
  const suggest = params.get("suggest")?.trim() ?? ""
  try {
    if (suggest) return withCors(request, NextResponse.json({ suggestions: (await suggestions(suggest.slice(0, 200))).slice(0, 8) }))
    if (next) {
      const page = isDataApiToken(next) ? await dataApiSearch(q, next) : await searchMore(next)
      return withCors(request, NextResponse.json(page))
    }
    if (!q) return withCors(request, NextResponse.json({ error: "Type something to search for." }, { status: 400 }))
    const page = useDataApi() ? await dataApiSearch(q.slice(0, 200)) : await search(q.slice(0, 200))
    return withCors(request, NextResponse.json(page, { headers: { "cache-control": "private, max-age=300" } }))
  } catch (error) {
    console.error("[youtube/search]", error)
    const status = typeof error === "object" && error && "status" in error ? Number((error as {status:number}).status) : 502
    const message = error instanceof Error ? error.message : "YouTube search failed. Try again in a moment."
    const code = typeof error === "object" && error && "code" in error ? (error as {code:string}).code : undefined
    return withCors(request, NextResponse.json({ error: message, code }, { status }))
  }
}

export function OPTIONS(request: NextRequest) { return corsPreflight(request) }
