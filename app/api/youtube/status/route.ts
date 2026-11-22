import { type NextRequest, NextResponse } from "next/server"
import { browserCookieFrom, corsPreflight, settingsStatus, withCors } from "@/lib/youtube-server"
import { dataApiConfigured } from "@/lib/youtube-data-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  return withCors(request, NextResponse.json({
    ...settingsStatus(browserCookieFrom(request.headers.get("cookie"))),
    dataApi: { configured: dataApiConfigured(), searchProvider: dataApiConfigured() && process.env.DEVON_YT_SEARCH_PROVIDER !== "innertube" ? "youtube-data-api" : "legacy", channelProvider: dataApiConfigured() && process.env.DEVON_YT_CHANNEL_PROVIDER !== "innertube" ? "youtube-data-api" : "legacy" },
  }, { headers: { "cache-control": "no-store" } }))
}

export function OPTIONS(request: NextRequest) { return corsPreflight(request) }
