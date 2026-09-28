import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** One-way cleanup for account cookies saved by older Devon builds. */
export async function DELETE() {
  const response = NextResponse.json({ removed: true }, { headers: { "cache-control": "no-store" } })
  for (let i = 0; i < 6; i++) {
    response.headers.append(
      "set-cookie",
      `devon_ytc_${i}=; Path=/api/youtube; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    )
  }
  return response
}
