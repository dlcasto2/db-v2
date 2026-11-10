/**
 * Devon AI's "suggest_actions" tool — the clickable next-step cards shown
 * after a file task. Shared by both backends (unlike the sandbox tools,
 * which differ between EdgeOne's own sandbox and Vercel's E2B one), since
 * it only needs the SSE channel, not a sandbox.
 *
 * Adapted from TencentEdgeOne/multimodal-file-assistant-agent (MIT)'s
 * custom-tools MCP server; deliver_file lives next to each backend's own
 * sandbox tools instead (lib/devon-ai/server/sandbox-tools.ts for Vercel,
 * inline in agents/ai-chat/index.ts for EdgeOne), since delivering a file
 * means reading it out of that backend's own sandbox.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { StreamChannel } from "./_devon-tools"

export const UI_SERVER = "ui"
export const UI_TOOL_NAMES = ["suggest_actions"].map((n) => `mcp__${UI_SERVER}__${n}`)

type ToolResult = { content: { type: "text"; text: string }[] }

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] })

export function createUiTools(ctx: { channel: StreamChannel }) {
  return [
    tool(
      "suggest_actions",
      "Show the person 2-5 clickable next-step options as cards, instead of writing them as a numbered list in your reply " +
        "(a text list isn't clickable). Use this once a file task is done, or whenever offering a short menu of concrete next " +
        "steps would help. Each option needs a short id, one emoji, a short title (under ~20 characters) and a one-line description.",
      {
        actions: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              emoji: z.string().min(1).max(8),
              title: z.string().min(1).max(60),
              description: z.string().min(1).max(200),
            }),
          )
          .min(1)
          .max(5),
      },
      async ({ actions }) => {
        ctx.channel.send("suggest_actions", { actions })
        return text("Shown to the person as clickable cards. Don't also list these as text, and stop here — wait for them to choose or send their next message.")
      },
    ),
  ]
}
