/**
 * Devon AI standalone backend.
 *
 * The handlers in app/ai-*\/route.ts are plain `POST(Request) => Response` functions,
 * so this server mounts them as-is instead of copying them. There is one copy of
 * the agent logic, and the Next.js app and this service can't drift apart.
 *
 * Auth routes (/auth-*, /account-sync) are deliberately not mounted: they rely on a
 * same-site session cookie and should stay on the main Devon origin.
 */

import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { timingSafeEqual } from "node:crypto"
import { modelConfigured } from "@/agents/_model"
import { redis } from "@/lib/devon-ai/server/kv"
import { sandboxConfigured } from "@/lib/devon-ai/server/sandbox-tools"

type Handler = (request: Request) => Promise<Response>
type RouteModule = { POST?: Handler }

// Loaded lazily so a problem in one route can't stop the server from starting.
const ROUTES: Record<string, () => Promise<RouteModule>> = {
  "/ai-chat": () => import("@/app/ai-chat/route"),
  "/ai-stop": () => import("@/app/ai-stop/route"),
  "/ai-history": () => import("@/app/ai-history/route"),
  "/ai-conversations": () => import("@/app/ai-conversations/route"),
  "/ai-delete-conversation": () => import("@/app/ai-delete-conversation/route"),
  "/ai-page-result": () => import("@/app/ai-page-result/route"),
  "/ai-session": () => import("@/app/ai-session/route"),
  "/ai-filesystem": () => import("@/app/ai-filesystem/route"),
  "/ai-feedback": () => import("@/app/ai-feedback/route"),
}

const env = process.env
const allowedOrigins = (env.DEVON_API_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean)
const allowAnyOrigin = allowedOrigins.includes("*")
const apiKey = (env.DEVON_API_KEY || "").trim()

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false
  return allowAnyOrigin || allowedOrigins.includes(origin.replace(/\/+$/, ""))
}

function keyMatches(given: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(apiKey)
  return a.length === b.length && timingSafeEqual(a, b)
}

const app = new Hono()

app.use(
  "*",
  cors({
    origin: (origin) => (originAllowed(origin) ? origin : ""),
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "makers-conversation-id", "Authorization", "x-devon-api-key"],
    maxAge: 86400,
  }),
)

// Optional API key for callers that aren't an allowed browser origin.
// Origin can be forged by non-browser clients, so daily limits remain important.
app.use("*", async (c, next) => {
  if (!apiKey || c.req.method === "OPTIONS" || c.req.path === "/health") return next()
  if (originAllowed(c.req.header("origin"))) return next()
  const bearer = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "")
  const given = c.req.header("x-devon-api-key") || bearer
  if (given && keyMatches(given)) return next()
  return c.json({ error: "unauthorized", message: "A valid API key is required." }, 401)
})

app.get("/health", (c) =>
  c.json({
    ok: true,
    model: modelConfigured(env),
    redis: Boolean(redis()),
    sandbox: sandboxConfigured(env),
    routes: Object.keys(ROUTES),
  }),
)

for (const [path, load] of Object.entries(ROUTES)) {
  app.post(path, async (c) => {
    const mod = await load()
    if (typeof mod.POST !== "function") {
      return c.json({ error: "not_found", message: `${path} has no POST handler` }, 404)
    }
    return mod.POST(c.req.raw)
  })
}

app.notFound((c) => c.json({ error: "not_found" }, 404))
app.onError((err, c) => {
  console.error("[devon-ai-api]", err)
  return c.json({ error: "internal_error", message: "Something went wrong on the server." }, 500)
})

const port = Number(env.PORT) || 8787
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[devon-ai-api] listening on :${info.port}`)
  if (!allowedOrigins.length) console.warn("[devon-ai-api] DEVON_API_ALLOWED_ORIGINS is empty: browsers will be blocked by CORS")
  if (!modelConfigured(env)) console.warn("[devon-ai-api] no model key set (ANTHROPIC_API_KEY or AI_GATEWAY_*)")
  if (!redis()) console.warn("[devon-ai-api] no Redis credentials: history, quota and sessions won't persist")
})
