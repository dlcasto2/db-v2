/**
 * Devon AI's tools for the visitor's own browser (private module, not a route).
 *
 * tabs_list / tab_open / tab_select, page_read / page_click / page_type /
 * page_select / page_scroll / page_navigate run in the visitor's Devon tab
 * (see _mailbox.ts for how results come back). session_update edits this
 * chat's session state on the server.
 *
 * Clicking, typing and choosing options ask the visitor's permission per site
 * in Devon itself; the browser refuses password and payment fields outright.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk"
import type { AgentMemory } from "@edgeone/types"
import { z } from "zod"
import { type PageResult, waitForResult } from "../_mailbox"
import { type SessionState, applySessionUpdate, recordPage, saveSession } from "../_session"

export const DEVON_SERVER = "devon"

/** Lets tools write to the chat's SSE stream once it has started */
export interface StreamChannel {
  send: (event: string, data: Record<string, unknown>) => void
}

interface DevonToolsContext {
  channel: StreamChannel
  // Only these are actually called (via waitForResult and saveSession below).
  // Narrowed to a Pick, not the full AgentMemory, so a store that only
  // implements this slice — such as the Redis-backed one Devon AI's Vercel
  // deployment uses (lib/devon-ai/server/store.ts) — can be passed here too.
  // EdgeOne's real store already satisfies this; nothing changes for it.
  store: Pick<AgentMemory, "getMessages" | "deleteMessage" | "clearMessages" | "state">
  conversationId: string
  signal?: AbortSignal
  /** Shared, mutable: tools update it and save it */
  session: { current: SessionState }
  logError: (...a: unknown[]) => void
}

/** Actions that change the page wait for the visitor's permission, so they get longer */
const APPROVAL_TOOLS = new Set(["page_click", "page_type", "page_select"])
const TIMEOUT_MS = 45_000
const APPROVAL_TIMEOUT_MS = 150_000

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) })

const tabId = z.string().max(40).optional().describe("Tab to act on (from tabs_list or the session block). Leave out for the ★ tab.")
const ref = z.number().int().positive().describe("The element's [ref] number from the latest page_read")
const element = z.string().max(120).describe("Short human description of the element, shown to the user (e.g. 'Sign in button')")

export function createDevonTools(ctx: DevonToolsContext) {
  /** Send one action to the browser and wait for its result */
  const callBrowser = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (!ctx.conversationId) return text("Page tools need a conversation ID.", true)
    const callId = crypto.randomUUID()
    ctx.channel.send("page_action", { callId, tool: name, args })
    const result: PageResult = await waitForResult(ctx.store, ctx.conversationId, callId, {
      timeoutMs: APPROVAL_TOOLS.has(name) ? APPROVAL_TIMEOUT_MS : TIMEOUT_MS,
      signal: ctx.signal,
      logError: ctx.logError,
    })
    if (result.ok && result.tab?.url && name !== "tabs_list") {
      ctx.session.current = recordPage(ctx.session.current, result.tab)
      await saveSession(ctx.store, ctx.conversationId, ctx.session.current, ctx.logError)
      ctx.channel.send("session", { session: ctx.session.current })
    }
    return text(result.text || (result.ok ? "Done." : "The action failed."), !result.ok)
  }

  return [
    tool(
      "tabs_list",
      "List the tabs open in the user's Devon browser: id, title, address, which one is visible, and which one page tools act on by default.",
      {},
      async () => callBrowser("tabs_list", {}),
    ),
    tool(
      "tab_open",
      "Open an address in a new Devon tab (through Devon's proxy) and make it the tab page tools act on. Returns the loaded page.",
      { url: z.string().min(1).max(2000).describe("Full address, e.g. https://example.com") },
      async (args) => callBrowser("tab_open", args),
    ),
    tool(
      "tab_select",
      "Switch the user's view to a tab and act on it from now on.",
      { tab_id: z.string().max(40) },
      async (args) => callBrowser("tab_select", args),
    ),
    tool(
      "page_read",
      "Read a page in the user's Devon tab: address, title, scroll position, the interactive elements numbered as [ref], and the visible text. " +
        "Call it before acting and after the page changes. Long pages: use offset to read further, or query to find elements and text containing a word.",
      {
        tab_id: tabId,
        query: z.string().max(100).optional().describe("Only list elements and text lines containing this"),
        offset: z.number().int().min(0).optional().describe("Character offset into the page text, for long pages"),
      },
      async (args) => callBrowser("page_read", args),
    ),
    tool(
      "page_click",
      "Click an element (link, button, checkbox, tab…) in the user's Devon tab. Needs the user's permission for the site. Returns what happened and the page afterwards.",
      { ref, element, tab_id: tabId },
      async (args) => callBrowser("page_click", args),
    ),
    tool(
      "page_type",
      "Type into a text field in the user's Devon tab. Replaces what's there unless clear is false; submit presses Enter after typing. " +
        "Needs the user's permission for the site. Never used for passwords or payment details (the browser refuses those).",
      {
        ref,
        text: z.string().max(5000),
        element,
        clear: z.boolean().optional().describe("Replace the current value (default true)"),
        submit: z.boolean().optional().describe("Press Enter after typing (default false)"),
        tab_id: tabId,
      },
      async (args) => callBrowser("page_type", args),
    ),
    tool(
      "page_select",
      "Choose an option in a dropdown (<select>) in the user's Devon tab, by its visible text or value. Needs the user's permission for the site.",
      { ref, option: z.string().max(300), element, tab_id: tabId },
      async (args) => callBrowser("page_select", args),
    ),
    tool(
      "page_scroll",
      "Scroll the user's Devon tab: up/down by about a screen, to the top/bottom, or to an element by ref.",
      {
        direction: z.enum(["up", "down", "top", "bottom"]).optional(),
        ref: ref.optional(),
        tab_id: tabId,
      },
      async (args) => callBrowser("page_scroll", args),
    ),
    tool(
      "page_navigate",
      "Load an address in the user's Devon tab, or go back, forward or reload. Returns the loaded page.",
      {
        to: z.string().min(1).max(2000).describe("An address, or 'back', 'forward' or 'reload'"),
        tab_id: tabId,
      },
      async (args) => callBrowser("page_navigate", args),
    ),
    tool(
      "session_update",
      "Update this chat's session state, which the user sees in the Session panel and which is shown to you in <devon_session> every turn. " +
        "For multi-step work: set the task and steps first, mark steps complete as you go, and add notes for facts worth keeping (found prices, names, decisions). " +
        "Step and note numbers are 1-based. Setting steps replaces the list.",
      {
        task: z.string().max(300).optional(),
        steps: z.array(z.string().max(200)).max(20).optional(),
        complete_steps: z.array(z.number().int().positive()).optional(),
        add_notes: z.array(z.string().max(300)).max(10).optional(),
        remove_notes: z.array(z.number().int().positive()).optional(),
      },
      async (args) => {
        ctx.session.current = applySessionUpdate(ctx.session.current, args)
        await saveSession(ctx.store, ctx.conversationId, ctx.session.current, ctx.logError)
        ctx.channel.send("session", { session: ctx.session.current })
        const s = ctx.session.current
        return text(
          `Session saved. Task: ${s.task || "(none)"}; steps: ${s.steps.map((x, i) => `${i + 1}${x.done ? "✓" : ""}`).join(" ") || "none"}; notes: ${s.notes.length}.`,
        )
      },
    ),
  ]
}

export const DEVON_TOOL_NAMES = [
  "tabs_list",
  "tab_open",
  "tab_select",
  "page_read",
  "page_click",
  "page_type",
  "page_select",
  "page_scroll",
  "page_navigate",
  "session_update",
].map((n) => `mcp__${DEVON_SERVER}__${n}`)
