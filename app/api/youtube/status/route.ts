import { NextResponse } from "next/server"
import { settingsStatus } from "@/lib/youtube-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/youtube/status -> the player, proxy setting and build time.
 */
export async function GET() {
  return NextResponse.json(settingsStatus(), { headers: { "cache-control": "no-store" } })
}
