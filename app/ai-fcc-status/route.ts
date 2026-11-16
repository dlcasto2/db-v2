/**
 * Free Claude Code status — Vercel-native route, POST /ai-fcc-status.
 *
 * Maintainer-only (same DEVON_AI_ADMIN_KEY gate as app/ai-feedback's digest
 * action): { admin_key } -> { configured, baseUrl, reachable, models?,
 * adminUrl?, error? }. Refused with 403 unless admin_key matches
 * DEVON_AI_ADMIN_KEY in this site's environment variables (refused the
 * same way if that variable is unset). See agents/_fcc_status.ts for what
 * this actually checks, and app/fcc-status/page.tsx for the web panel that
 * calls it (the web equivalent of fcc-cli's fcc-gui status pill).
 */

import { checkFccStatus } from "@/agents/_fcc_status"

export const runtime = "nodejs"

const JSON_HEADERS = { "Content-Type": "application/json; charset=UTF-8" }

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS })
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return jsonResponse({ status: "error", message: "Invalid JSON body" }, 400)

  const env = process.env
  const adminKey = env.DEVON_AI_ADMIN_KEY
  const givenKey = typeof body.admin_key === "string" ? body.admin_key : ""
  if (!adminKey || givenKey !== adminKey) return jsonResponse({ status: "error", message: "Not authorized" }, 403)

  const result = await checkFccStatus(env)
  return jsonResponse(result)
}
