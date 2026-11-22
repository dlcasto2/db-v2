import { type NextRequest, NextResponse } from "next/server"
import { YTError, channelVideos, channelVideosMore, corsPreflight, withCors } from "@/lib/youtube-server"
import { dataApiChannel, dataApiConfigured, isDataApiToken } from "@/lib/youtube-data-api"

export const runtime = "nodejs"
export const maxDuration = 30

const useDataApi = () => dataApiConfigured() && process.env.DEVON_YT_CHANNEL_PROVIDER !== "innertube"

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const c = params.get("c")?.trim() ?? ""
  const next = params.get("next") ?? ""
  try {
    if (next) {
      const page = isDataApiToken(next)
        ? await dataApiChannel("", next)
        : await channelVideosMore(next, (params.get("owner") ?? "").slice(0, 200))
      return withCors(request, NextResponse.json(page))
    }
    if (!c) return withCors(request, NextResponse.json({ error: "Type a channel to load." }, { status: 400 }))
    const page = useDataApi() ? await dataApiChannel(c.slice(0, 300)) : await channelVideos(c.slice(0, 300))
    return withCors(request, NextResponse.json(page, { headers: { "cache-control": "private, max-age=300" } }))
  } catch (error) {
    if (!(error instanceof YTError) || error.status >= 500) console.error("[youtube/channel]", c || "(next page)", error)
    const status = typeof error === "object" && error && "status" in error ? Number((error as {status:number}).status) : 502
    const message = error instanceof Error ? error.message : "Couldn't load this channel. Try again in a moment."
    const code = typeof error === "object" && error && "code" in error ? (error as {code:string}).code : undefined
    return withCors(request, NextResponse.json({ error: message, code }, { status }))
  }
}

export function OPTIONS(request: NextRequest) { return corsPreflight(request) }
