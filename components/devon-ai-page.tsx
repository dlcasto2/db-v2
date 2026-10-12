"use client"

import type React from "react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Check,
  Copy,
  Globe,
  Loader2,
  MessagesSquare,
  Plus,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  type ChatState,
  attachPageToDevonAi,
  deleteDevonAiChat,
  dismissDevonAiBanner,
  limitMessage,
  loadMoreDevonAiChats,
  newDevonAiChat,
  selectDevonAiChat,
  sendDevonAi,
  startDevonAi,
  stopDevonAi,
  useDevonAi,
} from "@/lib/devon-ai/store"
import type { ConversationSummary, Message } from "@/lib/devon-ai/types"
import { cn } from "@/lib/utils"

interface DevonAiPageProps {
  /** Open a link from a reply in a new Devon tab */
  onOpenLink: (url: string) => void
  onOpenApps: () => void
}

const STARTERS = [
  "Explain photosynthesis like I'm 12",
  "Write a Python script that sorts a list of names",
  "What's 30 factorial? Check it in the sandbox",
  "Give me 5 ideas for a weekend coding project",
]

const PAGE_STARTERS = ["Summarize this page", "What are the key points?", "Explain this page in simple words"]

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

export function DevonAiPage({ onOpenLink, onOpenApps }: DevonAiPageProps) {
  const chat = useDevonAi()
  const [chatsOpen, setChatsOpen] = useState(false)

  useEffect(() => {
    startDevonAi()
  }, [])

  const quotaLeft = chat.quota && chat.quota.limit > 0 ? Math.max(0, chat.quota.limit - chat.quota.used) : null
  const outOfMessages = chat.quota !== null && quotaLeft === 0 && chat.quota.resetAt > Date.now()

  return (
    <div className="relative flex h-full w-full bg-background">
      <ChatList chat={chat} className="hidden w-64 flex-shrink-0 border-r border-border md:flex" />

      {/* Mobile chat list */}
      {chatsOpen && (
        <div className="absolute inset-0 z-30 flex md:hidden">
          <ChatList chat={chat} className="w-72 max-w-[85%] border-r border-border shadow-2xl" onPicked={() => setChatsOpen(false)} />
          <button aria-label="Close chats" className="flex-1 bg-black/50" onClick={() => setChatsOpen(false)} />
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border px-3">
          <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onOpenApps}>
            <ArrowLeft /> Apps
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 rounded-full md:hidden"
            onClick={() => setChatsOpen(true)}
            title="Chats"
          >
            <MessagesSquare />
          </Button>
          <span className="ml-1 grid size-6 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Sparkles className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Devon AI</span>
          {quotaLeft !== null && (
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
            className="h-8 rounded-full"
            onClick={newDevonAiChat}
            disabled={chat.loading}
            title="New chat"
          >
            <Plus />
          </Button>
        </div>

        <ChatMessages chat={chat} onOpenLink={onOpenLink} />

        <div className="flex-shrink-0 px-3 pb-3 sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {chat.banner && <Banner kind={chat.banner.kind} message={chat.banner.message} />}
            {!chat.banner && outOfMessages && chat.quota && <Banner kind="rate_limited" message={limitMessage(chat.quota)} />}
            <Composer chat={chat} disabled={outOfMessages} quotaLeft={quotaLeft} />
          </div>
        </div>
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

function ChatMessages({ chat, onOpenLink }: { chat: ChatState; onOpenLink: (url: string) => void }) {
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
      className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin px-3 sm:px-6"
    >
      {chat.messages.length === 0 ? (
        chat.historyLoading ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <EmptyState chat={chat} />
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

function EmptyState({ chat }: { chat: ChatState }) {
  const starters = chat.pendingPage ? PAGE_STARTERS : STARTERS
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
          : "Devon AI can answer questions, write and run code in a sandbox, and read the pages you open — use ⋮ → Ask Devon AI about this page."}
      </p>
      <div className="relative mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
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
        </div>
      </div>
    )
  }

  const waiting = message.streaming && !message.content && !message.activity && !message.images?.length
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 grid size-7 flex-shrink-0 place-items-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
        <Sparkles className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {message.activity && (
          <div
            role="status"
            className={cn(
              "mb-2 inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] ring-1",
              message.activity.status === "error"
                ? "bg-amber-400/10 text-amber-200 ring-amber-400/25"
                : message.activity.status === "active"
                  ? "bg-primary/10 text-primary ring-primary/25"
                  : "text-muted-foreground ring-border",
            )}
          >
            {message.activity.status === "active" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : message.activity.status === "error" ? (
              <AlertTriangle className="size-3" />
            ) : (
              <Check className="size-3" />
            )}
            {message.activity.label}
          </div>
        )}
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
        {message.content && (
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
              }}
            >
              {message.content}
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
          <button
            onClick={() => {
              navigator.clipboard?.writeText(message.content).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              })
            }}
            className="mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition hover:bg-white/[0.06] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />} {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
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

function Composer({ chat, disabled, quotaLeft }: { chat: ChatState; disabled: boolean; quotaLeft: number | null }) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  // Text handed over from elsewhere (Prompt Gen, a refused message)
  useEffect(() => {
    if (!chat.draftVersion) return
    setValue(chat.draft)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [chat.draftVersion, chat.draft])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const canSend = chat.started && !chat.loading && !disabled && value.trim().length > 0
  const send = () => {
    if (!canSend) return
    sendDevonAi(value)
    setValue("")
  }

  const hint = useMemo(() => {
    const parts = ["Enter to send · Shift+Enter for a new line"]
    if (quotaLeft !== null) parts.push(`${quotaLeft} message${quotaLeft === 1 ? "" : "s"} left today`)
    return parts.join(" · ")
  }, [quotaLeft])

  return (
    <div>
      <div
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
        <div className="flex items-end gap-2 p-2 pl-4">
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
            placeholder={chat.pendingPage ? "Ask about this page…" : "Message Devon AI…"}
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
      <p className="mt-1.5 hidden text-center text-[11px] text-muted-foreground/70 sm:block">{hint}</p>
    </div>
  )
}
