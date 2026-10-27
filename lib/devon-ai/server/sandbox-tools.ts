/**
 * Devon AI's sandbox tools for the Vercel-native backend (private module, not a route).
 *
 * EdgeOne's deployment gets shell/files/code-interpreter tools for free from its
 * own Makers platform (context.tools.toClaudeMcpServer() in agents/ai-chat/index.ts).
 * Vercel has no equivalent — that's deliberate (see app/ai-chat/route.ts's own
 * comment): running shell commands directly in a Vercel function would reach
 * that function's own environment, real secrets included, not an isolated
 * sandbox. This file closes that gap the safe way instead, by giving the model
 * a throwaway E2B sandbox (https://e2b.dev) — a real, isolated micro-VM reached
 * over E2B's API — rather than anything on Devon's own server.
 *
 * Tool names (commands, files, code_interpreter) deliberately match EdgeOne's,
 * so the system prompt reads the same on both backends and the client's
 * existing tool-name label matching (lib/devon-ai/store.ts's TOOL_LABELS) picks
 * these up with no changes needed. "browser" (EdgeOne's fourth sandbox tool, a
 * headless browser) is intentionally not included here — Devon's own page_*
 * tools already cover "act on a page" for the visitor's actual tab, and a
 * second, separate headless browser is a materially bigger piece of
 * infrastructure than the shell/files/code-execution this port was missing.
 *
 * Devon AI is open to any visitor (rate limited, not authenticated), which
 * shapes every choice here:
 * - Nothing from Devon's or Vercel's own environment is passed into the
 *   sandbox (an empty `envs`), so there's nothing secret in it to leak.
 * - Outbound internet is available to the isolated sandbox by default. Set
 *   DEVON_AI_SANDBOX_ALLOW_NETWORK=0 or false to turn it off. Nothing from
 *   Devon's or Vercel's own environment is passed into the sandbox.
 * - Spinning up a *new* sandbox costs real E2B credits, unlike an ordinary
 *   chat message, so creating one is its own, separate daily cap
 *   (DEVON_AI_SANDBOX_DAILY_LIMIT) — reconnecting to a conversation's existing
 *   sandbox (see below) doesn't count against it.
 * - Command/code output is capped and truncated so one huge result can't blow
 *   up the chat stream or the model's context.
 *
 * One sandbox per conversation: its id is kept in the conversation's own
 * store.state (lib/devon-ai/server/store.ts), so a file `files` writes in one
 * turn is still there for `code_interpreter` or `commands` in a later turn of
 * the same chat, rather than every tool call getting a blank machine. Idle
 * sandboxes are left to expire on their own short, renewed timeout — there's
 * no explicit kill, since a conversation can always resume later.
 *
 * Needs E2B_API_KEY (console.e2b.dev → API Keys) in Vercel's project
 * environment variables; without it these tools simply aren't offered (see
 * sandboxConfigured), same as Devon AI's web search tool without WSA_API_KEY.
 */

import { createHash } from "node:crypto"
import { Sandbox } from "@e2b/code-interpreter"
import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { AiStore } from "./store"

export const SANDBOX_SERVER = "sandbox"
export const SANDBOX_TOOL_NAMES = ["commands", "files", "code_interpreter"].map((n) => `mcp__${SANDBOX_SERVER}__${n}`)

type Env = Record<string, string | undefined>

export function sandboxConfigured(env: Env): boolean {
  return Boolean(env.E2B_API_KEY)
}

// A sandbox left completely idle expires after this and the next tool call
// creates a fresh one; any tool call renews it back up to this from "now",
// so an active conversation's sandbox stays up for as long as it's in use.
const SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const COMMAND_TIMEOUT_MS = 30_000
const CODE_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 6000
const MAX_LIST_ENTRIES = 200

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
type ToolResult = { content: ToolContent[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n[…truncated, ${s.length - max} more characters]` : s
}

// ---------------------------------------------------------------------------
// A separate, small daily cap on *creating* a sandbox (not on using one that
// already exists). Deliberately not sharing agents/_quota.ts: that module's
// counters are already live on EdgeOne for the ordinary message quota, and
// this needs a distinct key namespace and env var, not a change to code a
// production deployment already depends on. Same mechanics, smaller and
// Vercel-only.
// ---------------------------------------------------------------------------

type CounterStore = Pick<AiStore, "getMessages" | "appendMessage" | "clearMessages">

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** `ds-` so it can never collide with the `dq-`/`dt-` namespaces agents/_quota.ts and _mailbox.ts use */
function sandboxCounterKey(visitor: string): string {
  return `ds-${createHash("sha256").update(`devon-ai-sandbox:${visitor}`).digest("hex").slice(0, 28)}`
}

function contentText(content: unknown): string {
  return typeof content === "string" ? content : ""
}

async function takeSandboxCreationQuota(
  store: CounterStore,
  env: Env,
  visitor: string,
  logError: (...args: unknown[]) => void,
): Promise<{ ok: boolean; used: number; limit: number }> {
  const limit = intEnv(env.DEVON_AI_SANDBOX_DAILY_LIMIT, 5)
  if (limit <= 0) return { ok: true, used: 0, limit: 0 }
  const day = utcDay(Date.now())
  const key = sandboxCounterKey(visitor)
  try {
    const entries = await store.getMessages({ conversationId: key, limit: 50, order: "desc" })
    let count = 0
    let stale = false
    for (const entry of entries) {
      try {
        const parsed = JSON.parse(contentText(entry.content)) as { d?: unknown; n?: unknown }
        if (parsed.d === day && typeof parsed.n === "number") count = Math.max(count, parsed.n)
        else stale = true
      } catch {
        stale = true
      }
    }
    if (count >= limit) return { ok: false, used: count, limit }
    if (stale) await store.clearMessages({ conversationId: key })
    await store.appendMessage({ conversationId: key, role: "user", content: JSON.stringify({ d: day, n: count + 1 }) })
    return { ok: true, used: count + 1, limit }
  } catch (e) {
    // A store hiccup shouldn't block sandbox use entirely — same philosophy as agents/_quota.ts
    logError("[sandbox-quota] store unavailable, letting it through:", e)
    return { ok: true, used: 0, limit }
  }
}

// ---------------------------------------------------------------------------

interface SandboxToolsContext {
  store: Pick<AiStore, "state" | "getMessages" | "appendMessage" | "clearMessages">
  env: Env
  /** Identifies the visitor for the sandbox-creation quota — same id used for the chat-message quota */
  visitor: string
  logError: (...args: unknown[]) => void
}

/** Reconnects to this conversation's sandbox if it still exists, else creates one (charging the creation quota) */
async function resolveSandbox(ctx: SandboxToolsContext): Promise<Sandbox> {
  const apiKey = ctx.env.E2B_API_KEY
  const networkSetting = ctx.env.DEVON_AI_SANDBOX_ALLOW_NETWORK?.trim().toLowerCase()
  const allowInternetAccess = networkSetting !== "0" && networkSetting !== "false"
  const storedId = await ctx.store.state.get<string>("e2bSandboxId")

  if (storedId) {
    try {
      const sbx = await Sandbox.connect(storedId, { apiKey })
      await sbx.setTimeout(SANDBOX_IDLE_TIMEOUT_MS)
      return sbx
    } catch (e) {
      ctx.logError("[sandbox] couldn't reconnect, starting a fresh one:", e)
      // Fall through — the stored id is stale (expired, killed, or never existed)
    }
  }

  const quota = await takeSandboxCreationQuota(ctx.store, ctx.env, ctx.visitor, ctx.logError)
  if (!quota.ok) {
    throw new Error(`Starting a new sandbox would go over today's limit (${quota.used}/${quota.limit}). Try again tomorrow.`)
  }

  const sbx = await Sandbox.create({ apiKey, timeoutMs: SANDBOX_IDLE_TIMEOUT_MS, envs: {}, allowInternetAccess })
  await ctx.store.state.set("e2bSandboxId", sbx.sandboxId)
  return sbx
}

export function createSandboxTools(ctx: SandboxToolsContext) {
  const withSandbox = async (fn: (sbx: Sandbox) => Promise<ToolResult>): Promise<ToolResult> => {
    let sbx: Sandbox
    try {
      sbx = await resolveSandbox(ctx)
    } catch (e) {
      return text(e instanceof Error ? e.message : String(e), true)
    }
    try {
      return await fn(sbx)
    } catch (e) {
      return text(`Sandbox error: ${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  return [
    tool(
      "commands",
      "Run a shell command in an isolated Linux sandbox (not the person's computer, and not Devon's own server). " +
        "Persists across this chat's tool calls (same sandbox, same filesystem) until it's been idle a while. " +
        `Outbound internet is available inside this isolated sandbox. Output is truncated past ${MAX_OUTPUT_CHARS} characters.`,
      {
        command: z.string().min(1).max(4000).describe("The shell command to run, e.g. 'ls -la' or 'python3 script.py'"),
        cwd: z.string().max(500).optional().describe("Working directory (default: the sandbox's home directory)"),
        timeout_ms: z.number().int().min(1000).max(COMMAND_TIMEOUT_MS).optional().describe(`Max ${COMMAND_TIMEOUT_MS}`),
      },
      async (args) =>
        withSandbox(async (sbx) => {
          try {
            const result = await sbx.commands.run(args.command, {
              cwd: args.cwd,
              timeoutMs: args.timeout_ms ?? COMMAND_TIMEOUT_MS,
            })
            const parts = [`exit ${result.exitCode}`]
            if (result.stdout) parts.push(`stdout:\n${truncate(result.stdout)}`)
            if (result.stderr) parts.push(`stderr:\n${truncate(result.stderr)}`)
            return text(parts.join("\n\n"))
          } catch (e) {
            // CommandExitError carries the real exitCode/stdout/stderr for a command
            // that ran but exited non-zero — not a tool failure, just report it as a result
            const err = e as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
            if (typeof err?.exitCode === "number") {
              const parts = [`exit ${err.exitCode}`]
              if (typeof err.stdout === "string" && err.stdout) parts.push(`stdout:\n${truncate(err.stdout)}`)
              if (typeof err.stderr === "string" && err.stderr) parts.push(`stderr:\n${truncate(err.stderr)}`)
              return text(parts.join("\n\n"))
            }
            throw e
          }
        }),
    ),
    tool(
      "files",
      "Read, write, list, create or remove files in the same sandbox 'commands' and 'code_interpreter' use. " +
        "op is required; path is required for every op; content is required for write. " +
        "Paths are inside the sandbox only — never the person's computer or Devon's own server/project files.",
      {
        op: z.enum(["read", "write", "list", "makeDir", "exists", "remove"]),
        path: z.string().min(1).max(1000),
        content: z.string().max(200_000).optional().describe("File content — required for write, ignored otherwise"),
      },
      async (args) =>
        withSandbox(async (sbx) => {
          switch (args.op) {
            case "read": {
              const content = await sbx.files.read(args.path)
              return text(truncate(content))
            }
            case "write": {
              if (args.content === undefined) return text("write needs 'content'.", true)
              const info = await sbx.files.write(args.path, args.content)
              return text(`Wrote ${info.path}`)
            }
            case "list": {
              const entries = await sbx.files.list(args.path)
              const shown = entries.slice(0, MAX_LIST_ENTRIES)
              const lines = shown.map((e) => `${e.type === "dir" ? "d" : "-"} ${e.size ?? ""}\t${e.path}`)
              const more = entries.length > shown.length ? `\n…and ${entries.length - shown.length} more` : ""
              return text(lines.join("\n") + more || "(empty directory)")
            }
            case "makeDir": {
              const created = await sbx.files.makeDir(args.path)
              return text(created ? `Created ${args.path}` : `${args.path} already exists`)
            }
            case "exists": {
              const ok = await sbx.files.exists(args.path)
              return text(ok ? "true" : "false")
            }
            case "remove": {
              await sbx.files.remove(args.path)
              return text(`Removed ${args.path}`)
            }
          }
        }),
    ),
    tool(
      "code_interpreter",
      "Run code in the sandbox and get back stdout/stderr, the value of the last expression, and any chart or image " +
        "it produces (e.g. matplotlib). Good for math, data work and charts. Variables, imports and functions persist " +
        "across calls within this chat, same as a notebook. Defaults to Python.",
      {
        code: z.string().min(1).max(50_000),
        language: z.string().max(40).optional().describe("python (default), javascript, typescript, r, java or bash"),
      },
      async (args) =>
        withSandbox(async (sbx) => {
          const execution = await sbx.runCode(args.code, {
            language: args.language,
            timeoutMs: CODE_TIMEOUT_MS,
          })
          const content: ToolContent[] = []
          if (execution.error) {
            content.push({ type: "text", text: `${execution.error.name}: ${execution.error.value}\n${truncate(execution.error.traceback)}` })
          } else {
            const stdout = execution.logs.stdout.join("")
            const stderr = execution.logs.stderr.join("")
            const parts: string[] = []
            if (stdout) parts.push(`stdout:\n${truncate(stdout)}`)
            if (stderr) parts.push(`stderr:\n${truncate(stderr)}`)
            const resultText = execution.text
            if (resultText) parts.push(`result:\n${truncate(resultText)}`)
            content.push({ type: "text", text: parts.join("\n\n") || "(no output)" })
            for (const result of execution.results) {
              const image = result.png || result.jpeg
              if (image) content.push({ type: "image", data: image, mimeType: result.png ? "image/png" : "image/jpeg" })
            }
          }
          return { content, isError: Boolean(execution.error) }
        }),
    ),
  ]
}
