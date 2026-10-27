"use client"

import React, { type ReactElement } from "react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Check,
  CircleCheck,
  CircleSlash,
  ClipboardList,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  MessagesSquare,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  type ChatState,
  attachPageToDevonAi,
  clearDevonAiBrowserMemory,
  clearDevonAiSession,
  deleteDevonAiChat,
  dismissDevonAiBanner,
  limitMessage,
  loadMoreDevonAiChats,
  newDevonAiChat,
  removeAllowedSite,
  respondDevonAiApproval,
  selectDevonAiChat,
  sendDevonAi,
  startDevonAi,
  stopDevonAi,
  submitDevonAiFeedback,
  useDevonAi,
} from "@/lib/devon-ai/store"
import type { ActionStep, ConversationSummary, FeedbackReasonCode, Message, UploadedFile } from "@/lib/devon-ai/types"
import { MAX_UPLOAD_FILES, MAX_UPLOAD_FILE_CHARS, MAX_UPLOAD_TEXT_CHARS } from "@/lib/devon-ai/uploads"
import { cn } from "@/lib/utils"

interface DevonAiPageProps {
  /** Open a link from a reply in a new Devon tab */
  onOpenLink: (url: string) => void
  onOpenApps?: () => void
  /** "page" = the full devon://apps/ai tab; "panel" = docked next to a website */
  variant?: "page" | "panel"
  /** Panel only: close it, or open the full Devon AI tab */
  onClose?: () => void
  onOpenFull?: () => void
}

const STARTERS = [
  "Explain photosynthesis like I'm 12",
  "Write a Python script that sorts a list of names",
  "What's 30 factorial? Check it in the sandbox",
  "Give me 5 ideas for a weekend coding project",
]

const PAGE_STARTERS = ["Summarize this page", "What are the key points?", "Explain this page in simple words"]

/** In the side panel, next to a site: things that use the page tools */
const PANEL_STARTERS = ["Summarize this page", "What can I do on this page?", "Find the search box and search for “news”", "Make a to-do list from this page"]
const TEXT_FILE_EXTENSIONS = new Set([
  "c", "cc", "cpp", "css", "csv", "go", "h", "html", "htm", "java", "js", "json", "jsx", "md", "py", "rs", "sh", "sql", "svg",
  "text", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml",
])
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() || ""
}

async function prepareUploads(selected: File[], existing: UploadedFile[]): Promise<UploadedFile[]> {
  if (existing.length + selected.length > MAX_UPLOAD_FILES) throw new Error(`Upload up to ${MAX_UPLOAD_FILES} files at a time.`)
  let totalChars = existing.reduce((sum, file) => sum + file.text.length, 0)
  const prepared = [...existing]
  for (const file of selected) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} is larger than the 100 MB per-file limit.`)
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const ext = extensionOf(file.name)
    if (ext === "zip") {
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(file)
      const entries = Object.values(zip.files).filter((entry) => !entry.dir)
      if (entries.length + prepared.length > MAX_UPLOAD_FILES) throw new Error(`The ZIP contains too many files (limit ${MAX_UPLOAD_FILES}).`)
      const startCount = prepared.length
      for (const entry of entries) {
        const entryExt = extensionOf(entry.name)
        if (!TEXT_FILE_EXTENSIONS.has(entryExt)) continue
        const declaredSize = (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
        if (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize > MAX_UPLOAD_FILE_CHARS) {
          throw new Error(`${entry.name} is larger than the ${MAX_UPLOAD_FILE_CHARS.toLocaleString()}-character per-file limit or has invalid ZIP metadata.`)
        }
        const text = await entry.async("string")
        totalChars += text.length
        if (totalChars > MAX_UPLOAD_TEXT_CHARS) throw new Error(`Extracted text is limited to ${MAX_UPLOAD_TEXT_CHARS.toLocaleString()} characters.`)
        prepared.push({ name: entry.name.split("/").pop() || entry.name, path: `${path}/${entry.name}`, mimeType: "text/plain", size: declaredSize ?? text.length, text })
      }
      if (prepared.length === startCount) {
        const text = `[ZIP archive "${file.name}" contained no supported text files.]`
        totalChars += text.length
        prepared.push({ name: file.name, path, mimeType: "application/zip", size: file.size, text })
      }
      continue
    }
    if (ext === "rar") {
      const text = `[RAR archive "${file.name}" (${file.size.toLocaleString()} bytes). Devon AI can see the archive name but cannot unpack this format yet.]`
      totalChars += text.length
      prepared.push({ name: file.name, path, mimeType: "application/vnd.rar", size: file.size, text })
      continue
    }
    if (!TEXT_FILE_EXTENSIONS.has(ext)) throw new Error(`${file.name} isn’t a supported text, HTML, ZIP, or folder file.`)
    const text = await file.slice(0, MAX_UPLOAD_FILE_CHARS * 4 + 4).text()
    if (text.length > MAX_UPLOAD_FILE_CHARS) throw new Error(`${file.name} exceeds the ${MAX_UPLOAD_FILE_CHARS.toLocaleString()}-character per-file limit.`)
    totalChars += text.length
    if (totalChars > MAX_UPLOAD_TEXT_CHARS) throw new Error(`Uploaded text is limited to ${MAX_UPLOAD_TEXT_CHARS.toLocaleString()} characters.`)
    prepared.push({ name: file.name, path, mimeType: file.type || "text/plain", size: file.size, text })
  }
  return prepared
}

function shorten(text: string, max = 70) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export function DevonAiPage({ onOpenLink, onOpenApps, variant = "page", onClose, onOpenFull }: DevonAiPageProps) {
  const chat = useDevonAi()
  const [chatsOpen, setChatsOpen] = useState(false)
  const [sessionOpen, setSessionOpen] = useState(false)
  const panel = variant === "panel"

  useEffect(() => {
    startDevonAi()
  }, [])

  const quotaLeft = chat.quota && chat.quota.limit > 0 ? Math.max(0, chat.quota.limit - chat.quota.used) : null
  const outOfMessages = chat.quota !== null && quotaLeft === 0 && chat.quota.resetAt > Date.now()
  const sessionCount =
    (chat.session?.task ? 1 : 0) + (chat.session?.notes.length ?? 0) + chat.allowedSites.length + chat.browserMemory.length + chat.recentReads.length

  return (
    <div className={cn("relative flex h-full w-full bg-background", panel && "bg-toolbar")}>
      {!panel && <ChatList chat={chat} className="hidden w-64 flex-shrink-0 border-r border-border md:flex" />}

      {/* Chat list as an overlay (phones, and the side panel) */}
      {chatsOpen && (
        <div className={cn("absolute inset-0 z-30 flex", !panel && "md:hidden")}>
          <ChatList chat={chat} className="w-72 max-w-[85%] border-r border-border shadow-2xl" onPicked={() => setChatsOpen(false)} />
          <button aria-label="Close chats" className="flex-1 bg-black/50" onClick={() => setChatsOpen(false)} />
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 flex-shrink-0 items-center gap-1.5 border-b border-border px-2 sm:px-3">
          {!panel && onOpenApps && (
            <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onOpenApps}>
              <ArrowLeft /> Apps
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn("h-8 rounded-full", !panel && "md:hidden")}
            onClick={() => setChatsOpen(true)}
            title="Chats"
          >
            <MessagesSquare />
          </Button>
          <span className="ml-1 grid size-6 flex-shrink-0 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Sparkles className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Devon AI</span>
          {quotaLeft !== null && !panel && (
            <span
              className={cn(
                "hidden rounded-full px-2.5 py-1 text-[11px] ring-1 sm:inline",
                outOfMessages ? "bg-destructive/10 text-destructive ring-destructive/30" : "text-muted-foreground ring-border",
              )}
              title={`Resets ${new Date(chat.quota!.resetAt).toLocaleString()}`}
            >
              {quotaLeft} of {chat.quota!.limit} left today
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn("relative h-8 rounded-full", sessionOpen && "bg-white/[0.08]")}
            onClick={() => setSessionOpen((v) => !v)}
            title="Session: what Devon AI is working on in this chat"
            aria-expanded={sessionOpen}
          >
            <ClipboardList />
            {!panel && <span className="hidden lg:inline">Session</span>}
            {sessionCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {sessionCount}
              </span>
            )}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={newDevonAiChat} disabled={chat.loading} title="New chat">
            <Plus />
          </Button>
          {panel && onOpenFull && (
            <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={onOpenFull} title="Open Devon AI in a tab">
              <Maximize2 />
            </Button>
          )}
          {panel && onClose && (
            <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={onClose} title="Close Devon AI">
              <X />
            </Button>
          )}
        </div>

        {sessionOpen && <SessionPanel chat={chat} onOpenLink={onOpenLink} onClose={() => setSessionOpen(false)} />}

        <ChatMessages chat={chat} onOpenLink={onOpenLink} panel={panel} />

        <div className={cn("flex-shrink-0 pb-3", panel ? "px-3" : "px-3 sm:px-6")}>
          <div className="mx-auto w-full max-w-3xl">
            {chat.approval && <ApprovalCard approval={chat.approval} />}
            {chat.banner && <Banner kind={chat.banner.kind} message={chat.banner.message} />}
            {!chat.banner && outOfMessages && chat.quota && <Banner kind="rate_limited" message={limitMessage(chat.quota)} />}
            <Composer chat={chat} disabled={outOfMessages} quotaLeft={quotaLeft} panel={panel} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

function SessionPanel({ chat, onOpenLink, onClose }: { chat: ChatState; onOpenLink: (url: string) => void; onClose: () => void }) {
  const s = chat.session
  const hasSessionState = Boolean(s?.task || s?.steps.length || s?.notes.length || s?.openQuestions.length || s?.pages.length || chat.allowedSites.length)
  const hasBrowserMemory = Boolean(chat.browserMemory.length || chat.recentReads.length)
  const empty = !hasSessionState && !hasBrowserMemory
  return (
    <div className="relative z-20 max-h-[55%] flex-shrink-0 overflow-y-auto scrollbar-thin border-b border-border bg-toolbar px-4 py-3 text-[13px] shadow-lg">
      <div className="mb-2 flex items-center gap-2">
        <ClipboardList className="size-4 text-primary" />
        <span className="flex-1 font-medium">Session</span>
        {hasSessionState && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
            disabled={chat.loading}
            onClick={() => {
              if (confirm("Clear this chat's session? Devon AI forgets its task, steps and notes, and the sites you allowed.")) clearDevonAiSession()
            }}
          >
            <Trash2 /> Clear
          </Button>
        )}
        <button onClick={onClose} title="Close" className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
      {empty ? (
        <p className="text-muted-foreground">
          Nothing yet. When Devon AI works on something with several steps, it keeps its task, steps and notes here, along with the pages it used and
          the sites you let it act on.
        </p>
      ) : (
        <div className="space-y-3">
          {s?.task && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Task</p>
              <p className="mt-0.5">{s.task}</p>
            </div>
          )}
          {!!s?.steps.length && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Steps · {s.steps.filter((x) => x.done).length}/{s.steps.length}
              </p>
              <ol className="mt-1 space-y-1">
                {s.steps.map((step, i) => (
                  <li key={i} className="flex gap-2">
                    {step.done ? (
                      <CircleCheck className="mt-0.5 size-3.5 flex-shrink-0 text-emerald-400" />
                    ) : (
                      <span className="mt-0.5 size-3.5 flex-shrink-0 rounded-full ring-1 ring-muted-foreground/60" />
                    )}
                    <span className={cn(step.done && "text-muted-foreground line-through")}>{step.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {!!s?.notes.length && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Notes</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {s.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          {hasBrowserMemory && (
            <div>
              <div className="flex items-center gap-2">
                <p className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Browser memory · this device</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 rounded-full px-2 text-[10px] text-muted-foreground"
                  onClick={() => {
                    if (confirm("Forget Devon AI notes and cached page text saved in this browser?")) clearDevonAiBrowserMemory()
                  }}
                >
                  Forget
                </Button>
              </div>
              {!!chat.browserMemory.length && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {chat.browserMemory.map((note, i) => <li key={i}>{note}</li>)}
                </ul>
              )}
              {!!chat.recentReads.length && (
                <ul className="mt-1 space-y-0.5">
                  {chat.recentReads.map((page) => (
                    <li key={page.url} className="truncate">
                      <button onClick={() => onOpenLink(page.url)} className="text-primary hover:underline" title={page.url}>
                        {page.title || hostOf(page.url)}
                      </button>
                      <span className="text-muted-foreground"> · recently read</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-muted-foreground">Stored locally in this browser; not synced to other devices.</p>
            </div>
          )}
          {!!s?.openQuestions.length && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Open questions</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-200/80">
                {s.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {!!s?.pages.length && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pages used</p>
              <ul className="mt-1 space-y-0.5">
                {s.pages.map((p) => (
                  <li key={p.url} className="truncate">
                    <button onClick={() => onOpenLink(p.url)} className="text-primary hover:underline" title={p.url}>
                      {p.title || hostOf(p.url)}
                    </button>
                    <span className="text-muted-foreground"> · {hostOf(p.url)}</span>
                    {p.state && <span className="text-muted-foreground"> — {p.state}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!chat.allowedSites.length && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Can click and type on</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {chat.allowedSites.map((site) => (
                  <span key={site} className="flex items-center gap-1 rounded-full bg-white/[0.05] py-0.5 pl-2.5 pr-1 ring-1 ring-border">
                    {site}
                    <button
                      onClick={() => removeAllowedSite(site)}
                      title={`Ask again before acting on ${site}`}
                      className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ApprovalCard({ approval }: { approval: NonNullable<ChatState["approval"]> }) {
  const warn = approval.irreversible || Boolean(approval.warning)
  return (
    <div
      role="alertdialog"
      aria-label="Devon AI wants to act on a page"
      className={cn("mb-2 rounded-xl px-3 py-3 ring-1", warn ? "bg-amber-400/10 ring-amber-400/40" : "bg-primary/10 ring-primary/35")}
    >
      <div className="flex items-start gap-2.5">
        {warn ? (
          <ShieldAlert className="mt-0.5 size-4 flex-shrink-0 text-amber-400" />
        ) : (
          <Hand className="mt-0.5 size-4 flex-shrink-0 text-primary" />
        )}
        <p className="flex-1 text-[13px]">
          Devon AI wants to <span className="font-medium text-foreground">{approval.description}</span> on{" "}
          <span className="font-medium text-foreground">{approval.site}</span>.
          {approval.irreversible && <span className="mt-0.5 block text-amber-200/90">This looks hard to undo — it's asked fresh every time, even on sites you've allowed.</span>}
          {approval.warning && <span className="mt-0.5 block text-amber-200/90">{approval.warning}</span>}
        </p>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5 pl-6">
        <Button size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => respondDevonAiApproval("once")}>
          Allow
        </Button>
        {!warn && (
          <Button size="sm" variant="secondary" className="h-7 rounded-full px-3 text-xs" onClick={() => respondDevonAiApproval("site")}>
            <ShieldCheck /> Allow on {approval.site} for this chat
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 rounded-full px-3 text-xs" onClick={() => respondDevonAiApproval("deny")}>
          Deny
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function timeLabel(ts?: number) {
  if (!ts || !Number.isFinite(ts)) return ""
  const diff = Date.now() - ts
  if (diff < 60_000) return "Just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  const d = new Date(ts)
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function ChatList({ chat, className, onPicked }: { chat: ChatState; className?: string; onPicked?: () => void }) {
  const items = chat.conversations
  return (
    <aside className={cn("flex-col bg-chrome", className)} aria-label="Devon AI chats">
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Chats</span>
        <Button
          size="sm"
          variant="secondary"
          className="h-7 rounded-full px-2.5 text-xs"
          onClick={() => {
            newDevonAiChat()
            onPicked?.()
          }}
          disabled={chat.loading}
        >
          <Plus /> New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-2">
        {items.length === 0 ? (
          chat.conversationsLoading ? null : (
            <p className="px-2 py-3 text-xs text-muted-foreground">Your chats will show up here.</p>
          )
        ) : (
          <ul className="space-y-0.5">
            {items.map((c: ConversationSummary) => {
              const active = c.id === chat.conversationId
              return (
                <li key={c.id} className="group relative">
                  <button
                    onClick={() => {
                      selectDevonAiChat(c.id)
                      onPicked?.()
                    }}
                    disabled={chat.loading && !active}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-2 pr-8 text-left transition-colors disabled:opacity-50",
                      active ? "bg-white/[0.08] text-foreground" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                    )}
                  >
                    <span className="block truncate text-[13px]">{c.title || "New chat"}</span>
                    <span className="block text-[11px] text-muted-foreground/80">{timeLabel(c.lastMessageAt ?? c.createdAt)}</span>
                  </button>
                  <button
                    title="Delete chat"
                    aria-label="Delete chat"
                    disabled={chat.loading}
                    onClick={() => {
                      if (confirm("Delete this chat? This can't be undone.")) deleteDevonAiChat(c.id)
                    }}
                    className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition hover:bg-white/[0.08] hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {chat.nextCursor && items.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-7 w-full rounded-lg text-xs text-muted-foreground"
            onClick={loadMoreDevonAiChats}
            disabled={chat.loadingMore}
          >
            {chat.loadingMore ? <Loader2 className="animate-spin" /> : null} Show more
          </Button>
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function ChatMessages({ chat, onOpenLink, panel }: { chat: ChatState; onOpenLink: (url: string) => void; panel: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Follow the reply as it streams, unless the visitor scrolled up to read
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [chat.messages])

  useEffect(() => {
    stick.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.conversationId])

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      className={cn("relative min-h-0 flex-1 overflow-y-auto scrollbar-thin", panel ? "px-3" : "px-3 sm:px-6")}
    >
      {chat.messages.length === 0 ? (
        chat.historyLoading ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <EmptyState chat={chat} panel={panel} />
        )
      ) : (
        <div className="mx-auto w-full max-w-3xl space-y-5 py-6">
          {chat.messages.map((m) => (
            <Bubble key={m.id} message={m} onOpenLink={onOpenLink} />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ chat, panel }: { chat: ChatState; panel: boolean }) {
  const starters = chat.pendingPage ? PAGE_STARTERS : panel ? PANEL_STARTERS : STARTERS
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center py-10">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.7_0.15_272/0.16),transparent)]" />
      <span className="relative grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/30">
        <Sparkles className="size-7" />
      </span>
      <h1 className="relative mt-4 text-2xl font-semibold tracking-tight">
        {chat.pendingPage ? "Ask about this page" : "What can I help with?"}
      </h1>
      <p className="relative mt-1 max-w-md text-center text-sm text-muted-foreground">
        {chat.pendingPage
          ? `Devon AI will read “${shorten(chat.pendingPage.title || hostOf(chat.pendingPage.url))}” to answer.`
          : panel
            ? "Devon AI can read this page, act on it with your permission, run isolated code, and work with files you attach."
            : "Devon AI can answer questions, run isolated code, work with files you attach, and read or use the pages you open. HTML previews run separately from sites."}
      </p>
      <div className={cn("relative mt-6 grid w-full max-w-xl grid-cols-1 gap-2", !panel && "sm:grid-cols-2")}>
        {starters.map((s) => (
          <button
            key={s}
            onClick={() => sendDevonAi(s)}
            disabled={!chat.started || chat.loading}
            className="rounded-xl bg-toolbar px-4 py-3 text-left text-sm text-muted-foreground ring-1 ring-border transition hover:text-foreground hover:ring-primary/40 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function Bubble({ message, onOpenLink }: { message: Message; onOpenLink: (url: string) => void }) {
  const [copied, setCopied] = useState(false)
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {message.page && (
            <button
              onClick={() => onOpenLink(message.page!.url)}
              title={message.page.url}
              className="mb-1 ml-auto flex max-w-full items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-border hover:text-foreground"
            >
              <Globe className="size-3 flex-shrink-0" />
              <span className="truncate">{message.page.title || hostOf(message.page.url)}</span>
            </button>
          )}
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/15 px-4 py-2.5 text-[14px] leading-relaxed text-foreground ring-1 ring-primary/25">
            {message.content}
          </div>
          {!!message.files?.length && (
            <div className="mt-1.5 flex flex-wrap justify-end gap-1">
              {message.files.map((file) => (
                <span key={`${file.path}:${file.name}`} title={`${file.path} · ${file.size.toLocaleString()} bytes`} className="flex max-w-full items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1 text-[11px] text-muted-foreground ring-1 ring-border">
                  <FileText className="size-3 flex-shrink-0" />
                  <span className="truncate">{file.path}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const confidenceMatch = !message.streaming ? message.content.match(/\s*\[Confidence:\s*(low|medium|high)\]\s*$/i) : null
  const displayContent = confidenceMatch ? message.content.slice(0, confidenceMatch.index).trimEnd() : message.content
  const confidence = confidenceMatch?.[1].toLowerCase()
  const waiting = message.streaming && !message.content && !message.actions?.some((a) => a.status === "active") && !message.images?.length
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 grid size-7 flex-shrink-0 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
        <Sparkles className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {!!message.actions?.length && <ActionSteps steps={message.actions} />}
        {waiting && (
          <div className="flex h-6 items-center gap-1" aria-label="Devon AI is thinking">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 animate-bounce rounded-full bg-muted-foreground/70"
                style={{ animationDelay: `${i * 0.15}s` }}
              />
            ))}
          </div>
        )}
        {confidence && (
          <span
            className={cn(
              "mb-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ring-1",
              confidence === "low"
                ? "bg-amber-400/10 text-amber-200 ring-amber-400/30"
                : confidence === "medium"
                  ? "bg-primary/10 text-primary ring-primary/30"
                  : "bg-emerald-400/10 text-emerald-200 ring-emerald-400/30",
            )}
            aria-label={`Confidence ${confidence}`}
          >
            {confidence[0].toUpperCase() + confidence.slice(1)} confidence
          </span>
        )}
        {displayContent && (
          <div
            className={cn(
              "devon-md text-[14px] leading-relaxed text-foreground/90",
              message.streaming && "devon-md-streaming",
              message.failed && "text-destructive",
            )}
          >
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => {
                      if (!href || !/^https?:\/\//i.test(href)) return
                      e.preventDefault()
                      onOpenLink(href)
                    }}
                  >
                    {children}
                  </a>
                ),
                pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
              }}
            >
              {displayContent}
            </Markdown>
          </div>
        )}
        {!!message.images?.length && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.images.map((img) =>
              img.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={img.id}
                  src={img.url}
                  alt="Image from Devon AI's tools"
                  className="max-h-[420px] w-full max-w-xl rounded-xl bg-white/[0.03] object-contain ring-1 ring-border"
                />
              ) : null,
            )}
          </div>
        )}
        {!message.streaming && message.content && !message.failed && (
          <div className="mt-1.5 flex items-center gap-1">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(message.content).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                })
              }}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition hover:bg-white/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
            </button>
            <FeedbackButtons message={message} />
          </div>
        )}
      </div>
    </div>
  )
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const codeElement = React.Children.toArray(children).find((child) => React.isValidElement(child)) as
    | ReactElement<{ className?: string; children?: React.ReactNode }>
    | undefined
  const code = String(codeElement?.props.children ?? "")
  const language = codeElement?.props.className?.match(/language-([\w+#-]+)/i)?.[1]?.toLowerCase() || ""
  const html = language === "html" || /<!doctype html|<html[\s>]/i.test(code)
  const extension = language === "javascript" ? "js" : language === "typescript" ? "ts" : language === "python" ? "py" : language || "txt"
  const preview = html
    ? (() => {
        const policy =
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; ` +
          `img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'">`
        return /<head[^>]*>/i.test(code) ? code.replace(/<head[^>]*>/i, (head) => `${head}${policy}`) : `<!doctype html><head>${policy}</head>${code}`
      })()
    : ""

  const download = () => {
    const file = new File([code], `devon-generated.${extension}`, { type: html ? "text/html" : "text/plain" })
    const url = URL.createObjectURL(file)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = file.name
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const share = async () => {
    const file = new File([code], `devon-generated.${extension}`, { type: html ? "text/html" : "text/plain" })
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        throw error
      }
    }
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } else {
      download()
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl ring-1 ring-border">
      <div className="flex items-center justify-between gap-2 bg-white/[0.04] px-3 py-1.5">
        <span className="truncate text-[11px] text-muted-foreground">{language || "code"}</span>
        <div className="flex items-center gap-1">
          {html && (
            <details className="group relative">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
                <Eye className="size-3" /> Preview
              </summary>
              <div className="absolute right-0 top-full z-10 mt-1 w-[min(80vw,36rem)] overflow-hidden rounded-lg bg-background p-1 shadow-xl ring-1 ring-border">
                <iframe title="Isolated HTML preview" sandbox="allow-scripts" srcDoc={preview} className="h-72 w-full rounded-md bg-white" />
              </div>
            </details>
          )}
          <button onClick={download} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
            <Download className="size-3" /> Download
          </button>
          <button onClick={() => void share().catch(() => download())} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground">
            <Upload className="size-3" /> {copied ? "Copied" : "Share"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto bg-black/20 p-3 text-[12px] leading-relaxed">{children}</pre>
    </div>
  )
}

const FEEDBACK_REASONS: { code: FeedbackReasonCode; label: string }[] = [
  { code: "wrong_fact", label: "Wrong fact" },
  { code: "misread_page", label: "Misread the page" },
  { code: "bad_action", label: "Bad/unsafe action" },
  { code: "other", label: "Other" },
]

/** Thumbs up/down on a reply. Up sends right away; down opens reason chips + an optional note first. */
function FeedbackButtons({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<FeedbackReasonCode | null>(null)
  const [note, setNote] = useState("")

  if (message.feedback) {
    return (
      <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
        {message.feedback === "up" ? <ThumbsUp className="size-3 fill-current" /> : <ThumbsDown className="size-3 fill-current" />} Thanks for the
        feedback
      </span>
    )
  }

  return (
    <div className="relative opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => submitDevonAiFeedback(message.id, "up")}
          title="Good reply"
          className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
        >
          <ThumbsUp className="size-3" />
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          title="Something's wrong with this reply"
          aria-expanded={open}
          className={cn("grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-white/[0.06] hover:text-foreground", open && "bg-white/[0.08] text-foreground")}
        >
          <ThumbsDown className="size-3" />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg bg-toolbar p-2 shadow-xl ring-1 ring-border">
          <div className="flex flex-wrap gap-1">
            {FEEDBACK_REASONS.map((r) => (
              <button
                key={r.code}
                onClick={() => setReason(r.code)}
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] ring-1 transition",
                  reason === r.code ? "bg-primary/20 text-foreground ring-primary/40" : "text-muted-foreground ring-border hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="Add a note (optional)"
            className="mt-1.5 w-full rounded-md bg-white/[0.04] px-2 py-1 text-[11px] outline-none ring-1 ring-border placeholder:text-muted-foreground focus:ring-primary/50"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-6 rounded-full px-2.5 text-[11px]" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-6 rounded-full px-2.5 text-[11px]"
              disabled={!reason}
              onClick={() => {
                submitDevonAiFeedback(message.id, "down", reason ?? undefined, note)
                setOpen(false)
              }}
            >
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ActionSteps({ steps }: { steps: ActionStep[] }) {
  return (
    <ul className="mb-2 space-y-1">
      {steps.map((step) => (
        <li key={step.id} role="status" className="flex items-start gap-2 text-[12px]">
          {step.status === "active" ? (
            <Loader2 className="mt-0.5 size-3.5 flex-shrink-0 animate-spin text-primary" />
          ) : step.status === "error" ? (
            <CircleSlash className="mt-0.5 size-3.5 flex-shrink-0 text-amber-400" />
          ) : (
            <Check className="mt-0.5 size-3.5 flex-shrink-0 text-muted-foreground" />
          )}
          <span className={cn("min-w-0", step.status === "active" ? "text-primary" : "text-muted-foreground")}>
            {step.status === "done" ? step.doneLabel : step.label}
            {step.note && <span className="block text-[11px] text-amber-200/80">{step.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Banner + input
// ---------------------------------------------------------------------------

function Banner({ kind, message }: { kind: string; message: string }) {
  const severe = kind === "not_configured" || kind === "unavailable" || kind === "error"
  return (
    <div
      role="alert"
      className={cn(
        "mb-2 flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-[13px] ring-1",
        severe ? "bg-destructive/10 text-red-100 ring-destructive/30" : "bg-amber-400/10 text-amber-100 ring-amber-400/25",
      )}
    >
      <AlertTriangle className={cn("mt-0.5 size-4 flex-shrink-0", severe ? "text-destructive" : "text-amber-400")} />
      <span className="flex-1">{message}</span>
      <button onClick={dismissDevonAiBanner} title="Dismiss" className="grid size-5 place-items-center rounded-full opacity-70 hover:opacity-100">
        <X className="size-3.5" />
      </button>
    </div>
  )
}

function Composer({ chat, disabled, quotaLeft, panel }: { chat: ChatState; disabled: boolean; quotaLeft: number | null; panel: boolean }) {
  const [value, setValue] = useState("")
  const [uploads, setUploads] = useState<UploadedFile[]>([])
  const [uploadError, setUploadError] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setUploads([])
    setUploadError("")
  }, [chat.conversationId])

  // Text handed over from elsewhere (Prompt Gen, a refused message)
  useEffect(() => {
    if (!chat.draftVersion) return
    setValue(chat.draft)
    setUploads(chat.draftFiles)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [chat.draftVersion, chat.draft, chat.draftFiles])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const canSend = chat.started && !chat.loading && !disabled && (value.trim().length > 0 || uploads.length > 0)
  const addUploads = async (files: File[]) => {
    setUploadError("")
    try {
      setUploads(await prepareUploads(files, uploads))
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not read the selected files.")
    }
    if (fileInput.current) fileInput.current.value = ""
    if (folderInput.current) folderInput.current.value = ""
  }
  const send = () => {
    if (!canSend) return
    sendDevonAi(value.trim() || "Please review the uploaded files.", uploads)
    setValue("")
    setUploads([])
  }

  const hint = useMemo(() => {
    const parts = ["Enter to send · Shift+Enter for a new line"]
    if (quotaLeft !== null) parts.push(`${quotaLeft} message${quotaLeft === 1 ? "" : "s"} left today`)
    return parts.join(" · ")
  }, [quotaLeft])

  return (
    <div>
      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return
          event.preventDefault()
          void addUploads(Array.from(event.dataTransfer.files))
        }}
        className={cn(
          "rounded-2xl bg-toolbar ring-1 ring-border transition focus-within:ring-2 focus-within:ring-primary/60",
          disabled && "opacity-60",
        )}
      >
        {chat.pendingPage && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Globe className="size-3.5 flex-shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-xs">
              <span className="text-foreground">{chat.pendingPage.title || hostOf(chat.pendingPage.url)}</span>
              <span className="text-muted-foreground"> · {hostOf(chat.pendingPage.url)}</span>
            </span>
            <button
              onClick={() => attachPageToDevonAi(null)}
              title="Don't include this page"
              className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
        )}
        {!!uploads.length && (
          <div className="border-b border-border px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {uploads.map((file, index) => (
                <span key={`${file.path}:${file.name}:${index}`} title={`${file.path} · ${file.size.toLocaleString()} bytes`} className="flex max-w-full items-center gap-1 rounded-full bg-white/[0.05] px-2 py-1 text-[11px] ring-1 ring-border">
                  <FileText className="size-3 flex-shrink-0 text-primary" />
                  <span className="max-w-48 truncate">{file.path}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.path}`}
                    onClick={() => setUploads((current) => current.filter((entry) => entry !== file))}
                    className="grid size-4 flex-shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-white/[0.1] hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">ZIPs and folders share readable text files. RAR selections include the filename only; contents aren’t unpacked.</p>
          </div>
        )}
        <div className="flex items-end gap-2 p-2 pl-4">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".c,.cc,.cpp,.css,.csv,.go,.h,.html,.htm,.java,.js,.json,.jsx,.md,.py,.rar,.rs,.sh,.sql,.svg,.text,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zip"
            className="hidden"
            onChange={(event) => void addUploads(Array.from(event.currentTarget.files ?? []))}
          />
          <input
            type="file"
            multiple
            accept=".c,.cc,.cpp,.css,.csv,.go,.h,.html,.htm,.java,.js,.json,.jsx,.md,.py,.rar,.rs,.sh,.sql,.svg,.text,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zip"
            className="hidden"
            ref={(element) => {
              folderInput.current = element
              element?.setAttribute("webkitdirectory", "")
            }}
            onChange={(event) => void addUploads(Array.from(event.currentTarget.files ?? []))}
          />
          <div className="flex flex-col gap-1">
            <button type="button" disabled={disabled || chat.loading} onClick={() => fileInput.current?.click()} title="Attach files or ZIP" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40">
              <Upload className="size-4" />
            </button>
            <button type="button" disabled={disabled || chat.loading} onClick={() => folderInput.current?.click()} title="Upload a folder" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-white/[0.08] hover:text-foreground disabled:opacity-40">
              <FileText className="size-4" />
            </button>
          </div>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            maxLength={8000}
            disabled={disabled}
            placeholder={uploads.length ? "Ask Devon AI about these files…" : chat.pendingPage ? "Ask about this page…" : panel ? "Ask or tell Devon AI what to do…" : "Message Devon AI…"}
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          />
          {chat.loading ? (
            <button
              onClick={stopDevonAi}
              title="Stop"
              className="grid size-9 flex-shrink-0 place-items-center rounded-xl bg-white/[0.1] text-foreground transition hover:bg-white/[0.16]"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!canSend}
              title="Send"
              className="grid size-9 flex-shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground transition disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
      {uploadError && <p role="alert" className="mt-1 text-center text-xs text-destructive">{uploadError}</p>}
      <p className={cn("mt-1.5 hidden text-center text-[11px] text-muted-foreground/70", panel ? "block" : "sm:block")}>
        {panel && quotaLeft !== null ? `${quotaLeft} message${quotaLeft === 1 ? "" : "s"} left today` : hint}
      </p>
    </div>
  )
}
