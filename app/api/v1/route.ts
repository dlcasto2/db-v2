/**
 * Devon AI Public API — GET /api/v1
 *
 * Health check and endpoint listing. No auth, no body.
 */

export const runtime = "nodejs"

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      api: "Devon AI",
      version: "1",
      status: "ok",
      base_url: "https://browser.lovedub.net/api/v1",
      endpoints: [
        { method: "POST", path: "/api/v1/chat",                         description: "Send a message to Devon AI (buffered or streaming SSE)" },
        { method: "POST", path: "/api/v1/conversations",                description: "List conversations for a user_id" },
        { method: "GET",  path: "/api/v1/conversations/:id/messages",   description: "Fetch message history for a conversation" },
        { method: "POST", path: "/api/v1/conversations/:id/stop",       description: "Stop active generation for a conversation" },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json; charset=UTF-8" } },
  )
}
