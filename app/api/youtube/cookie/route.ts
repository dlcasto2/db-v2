import { type NextRequest, NextResponse } from "next/server"
import {
  YTError,
  browserCookieFrom,
  browserCookieHeaders,
  describeCookie,
  normalizeCookie,
} from "@/lib/youtube-server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The YouTube page's cookie box.
 *   GET    -> whether this browser has a YouTube cookie saved (never the value)
 *   POST   {cookie} -> saves it in this browser (HttpOnly, only sent to /api/youtube)
 *   DELETE -> removes it
 */
export async function GET(request: NextRequest) {
  return NextResponse.json(describeCookie(browserCookieFrom(request.headers.get("cookie"))), {
    headers: { "cache-control": "no-store" },
  })
}

export async function POST(request: NextRequest) {
  // Only the Devon page itself may save a cookie
  const origin = request.headers.get("origin")
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 })
  }
  let raw = ""
  try {
    raw = String((await request.json())?.cookie ?? "")
  } catch {
    return NextResponse.json({ error: "Send the cookie as JSON." }, { status: 400 })
  }
  if (raw.length > 30000) return NextResponse.json({ error: "That cookie is too long." }, { status: 413 })
  const cookie = normalizeCookie(raw)
  const info = describeCookie(cookie)
  if (!info.set || !cookie.includes("=")) {
    return NextResponse.json({ error: "That doesn't look like a YouTube cookie. Copy the whole cookie: line value." }, { status: 400 })
  }
  try {
    const res = NextResponse.json(info, { headers: { "cache-control": "no-store" } })
    for (const header of browserCookieHeaders(cookie)) res.headers.append("set-cookie", header)
    return res
  } catch (error) {
    const status = error instanceof YTError ? error.status : 500
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't save it." }, { status })
  }
}

export async function DELETE() {
  const res = NextResponse.json({ set: false }, { headers: { "cache-control": "no-store" } })
  for (const header of browserCookieHeaders("")) res.headers.append("set-cookie", header)
  return res
}
