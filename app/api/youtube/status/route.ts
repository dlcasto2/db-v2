import { type NextRequest, NextResponse } from "next/server"
import { browserCookieFrom, settingsStatus } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/youtube/status -> whether the server sees DEVON_YT_COOKIE / DEVON_YT_PROXY,
 * and when this build was made. Only yes/no and counts; never the values.
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(settingsStatus(browserCookieFrom(request.headers.get("cookie"))), { headers: { "cache-control": "no-store" } })
}
