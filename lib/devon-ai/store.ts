"use client"

/**
 * Devon AI's chat state, kept outside React.
 *
 * Devon only renders the active tab's internal page, so the Devon AI page
 * unmounts whenever you switch tabs. Keeping the conversation, the running
 * stream and the sidebar here means a reply keeps arriving in the background
 * and is there when you come back. The logic follows the starter's App.tsx
 * (TencentEdgeOne/claude-agent-starter-node, MIT).
 */

import { useSyncExternalStore } from "react"
import {
  type ChatFailure,
  deleteConversation as deleteConversationApi,
  fetchConversationHistory,
  listConversations,
  sendMessageStream,
  stopAgent,
} from "@/lib/devon-ai/api"
import {
  base64ToBlob,
  createObjectUrl,
  deleteConversationImages,
  deleteSnapshot,
  loadConversationImages,
  loadSnapshot,
  makeStorageKey,
  revokeAllObjectUrls,
  saveImage,
  saveSnapshot,
} from "@/lib/devon-ai/storage"
import type { ConversationSummary, ImageAttachment, ImageSsePayload, Message, PageContext, Quota } from "@/lib/devon-ai/types"

export type BannerKind = "not_configured" | "unavailable" | "rate_limited" | "notice" | "error"

export interface ChatState {
  started: boolean
  userId: string
  conversationId: string
  messages: Message[]
  /** A reply is streaming */
  loading: boolean
  historyLoading: boolean
  conversations: ConversationSummary[]
  conversationsLoading: boolean
  loadingMore: boolean
  nextCursor?: string
  quota: Quota | null
  banner: { kind: BannerKind; message: string } | null
  /** Page attached to the next question ("Ask Devon AI about this page") */
  pendingPage: PageContext | null
  /** Text to put in the input box (from Prompt Gen); `draftVersion` changes each time */
  draft: string
  draftVersion: number
}

const CONVERSATION_KEY = "devon_ai_conversation"
const USER_KEY = "devon_ai_uid"
const QUOTA_KEY = "devon_ai_quota"
const PAGE_SIZE = 20

const INITIAL: ChatState = {
  started: false,
  userId: "",
  conversationId: "",
  messages: [],
  loading: false,
  historyLoading: false,
  conversations: [],
  conversationsLoading: false,
  loadingMore: false,
  quota: null,
  banner: null,
  pendingPage: null,
  draft: "",
  draftVersion: 0,
}

let state: ChatState = INITIAL
const listeners = new Set<() => void>()

function set(patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }
  listeners.forEach((l) => l())
  scheduleSnapshot()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDevonAi(): ChatState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  )
}

export function getDevonAiState(): ChatState {
  return state
}

// ---------------------------------------------------------------------------
// IDs and saved quota
// ---------------------------------------------------------------------------

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode: works for this session only
  }
}

function savedQuota(): Quota | null {
  try {
    const q = JSON.parse(readStorage(QUOTA_KEY) || "null") as Quota | null
    if (!q || typeof q.resetAt !== "number" || q.resetAt <= Date.now()) return null
    return q
  } catch {
    return null
  }
}

function rememberQuota(quota: Quota) {
  writeStorage(QUOTA_KEY, JSON.stringify(quota))
  set({ quota })
}

// ---------------------------------------------------------------------------
// Snapshots (debounced, only once the visitor has sent something here)
// ---------------------------------------------------------------------------

let snapshotTimer: ReturnType<typeof setTimeout> | null = null
let snapshotArmed = false
let lastSnapshotMessages: Message[] | null = null
let pendingSnapshot: { conversationId: string; messages: Message[] } | null = null

function scheduleSnapshot() {
  if (!snapshotArmed || state.messages === lastSnapshotMessages || state.messages.length === 0) return
  const messages = (lastSnapshotMessages = state.messages)
  const conversationId = state.conversationId
  if (snapshotTimer) {
    clearTimeout(snapshotTimer)
    // A different chat's save was still waiting: write it now rather than drop it
    if (pendingSnapshot && pendingSnapshot.conversationId !== conversationId) {
      void saveSnapshot(pendingSnapshot.conversationId, pendingSnapshot.messages)
    }
  }
  pendingSnapshot = { conversationId, messages }
  snapshotTimer = setTimeout(() => {
    pendingSnapshot = null
    snapshotTimer = null
    void saveSnapshot(conversationId, messages)
  }, 500)
}

// ---------------------------------------------------------------------------
// Loading conversations
// ---------------------------------------------------------------------------

let loadToken = 0

async function loadConversation(conversationId: string) {
  const token = ++loadToken
  snapshotArmed = false
  revokeAllObjectUrls()
  set({ historyLoading: true, messages: [] })
  try {
    const [history, snapshot, images] = await Promise.all([
      fetchConversationHistory(conversationId, state.userId),
      loadSnapshot(conversationId),
      loadConversationImages(conversationId),
    ])
    if (token !== loadToken) return
    const urls = new Map(images.map((r) => [r.imageId, createObjectUrl(r.storageKey, r.blob)]))
    const withImages = (m: Message): Message =>
      m.images?.length ? { ...m, images: m.images.map((img) => ({ ...img, url: urls.get(img.id) ?? "" })).filter((img) => img.url) } : m
    const messages = (snapshot.length ? snapshot : history).map(withImages)
    set({ messages })
  } finally {
    if (token === loadToken) set({ historyLoading: false })
  }
}

async function refreshConversations(mode: "replace" | "append" = "replace") {
  if (mode === "append") set({ loadingMore: true })
  else set({ conversationsLoading: true })
  try {
    const res = await listConversations(state.userId, mode === "append" ? state.nextCursor : undefined, PAGE_SIZE)
    set((s) => {
      if (mode === "replace") {
        // Keep a just-started chat the server hasn't listed yet
        const pending = s.conversations.filter(
          (c) => c.id === s.conversationId && !res.conversations.some((r) => r.id === c.id) && s.messages.length > 0,
        )
        return { conversations: [...pending, ...res.conversations], nextCursor: res.nextCursor }
      }
      const seen = new Set(s.conversations.map((c) => c.id))
      return { conversations: [...s.conversations, ...res.conversations.filter((c) => !seen.has(c.id))], nextCursor: res.nextCursor }
    })
  } finally {
    set(mode === "append" ? { loadingMore: false } : { conversationsLoading: false })
  }
}

/** First visit to Devon AI in this page load: restore IDs, the chat list and the open chat */
export function startDevonAi() {
  if (state.started || typeof window === "undefined") return
  let userId = readStorage(USER_KEY)
  if (!userId || !/^[A-Za-z0-9_-]{8,64}$/.test(userId)) {
    userId = uuid()
    writeStorage(USER_KEY, userId)
  }
  const existing = readStorage(CONVERSATION_KEY)
  const conversationId = existing || uuid()
  if (!existing) writeStorage(CONVERSATION_KEY, conversationId)
  set({ started: true, userId, conversationId, quota: savedQuota() })
  void refreshConversations("replace")
  if (existing) void loadConversation(conversationId)
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

let abortCtrl: AbortController | null = null
let botMsgId = ""

/** Tool chip text while it runs, and once it's done */
const TOOL_LABELS: [RegExp, string, string][] = [
  [/^(web_search|search)/i, "Searching the web", "Searched the web"],
  [/^browser|browse/i, "Browsing the web", "Browsed the web"],
  [/^(code_interpreter|code-interpreter|interpreter)/i, "Running code", "Ran code"],
  [/^(files|file_|fs_)/i, "Working with files", "Worked with files"],
  [/^(commands|command_|cmd_|shell|exec)/i, "Running a command", "Ran a command"],
  [/^(skill|load_skill)$/i, "Loading a skill", "Loaded a skill"],
]

function toolLabels(tool: string): { label: string; doneLabel: string } {
  const hit = TOOL_LABELS.find(([re]) => re.test(tool))
  if (hit) return { label: hit[1], doneLabel: hit[2] }
  const name = tool.replace(/_/g, " ")
  return { label: `Using ${name}`, doneLabel: `Used ${name}` }
}

function updateBot(fn: (m: Message) => Message) {
  const id = botMsgId
  set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }))
}

function finishActivity() {
  updateBot((m) =>
    m.activity?.status === "active"
      ? { ...m, activity: { label: m.activity.doneLabel ?? m.activity.label, status: "done" } }
      : m,
  )
}

async function handleImage(payload: ImageSsePayload, conversationId: string, messageId: string) {
  const blob = base64ToBlob(payload.base64, payload.mimeType || "image/png")
  const storageKey = makeStorageKey(conversationId, payload.imageId)
  let persistent = false
  try {
    await saveImage({ conversationId, messageId, imageId: payload.imageId, blob, mimeType: payload.mimeType || "image/png" })
    persistent = true
  } catch {
    // shown for this session only
  }
  const attachment: ImageAttachment = {
    id: payload.imageId,
    storageKey,
    url: persistent ? createObjectUrl(storageKey, blob) : URL.createObjectURL(blob),
    mimeType: payload.mimeType || "image/png",
    size: blob.size,
    createdAt: Date.now(),
    persistent,
  }
  set((s) => ({ messages: s.messages.map((m) => (m.id === messageId ? { ...m, images: [...(m.images || []), attachment] } : m)) }))
}

function formatReset(resetAt: number): string {
  if (!resetAt) return "tomorrow"
  const d = new Date(resetAt)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return sameDay ? `at ${time}` : `tomorrow at ${time}`
}

export function limitMessage(quota: Quota): string {
  return `You've used all ${quota.limit} Devon AI messages for today. You can send more ${formatReset(quota.resetAt)}.`
}

/** Turn a failed send into what the chat shows */
function applyFailure(failure: ChatFailure, userMsgId: string, text: string, page: PageContext | undefined) {
  // The request never reached the model: take the question back out and put it in the input again
  const withdraw = failure.kind !== "error"
  if (withdraw) {
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== userMsgId && m.id !== botMsgId),
      draft: text,
      draftVersion: s.draftVersion + 1,
      pendingPage: page ?? s.pendingPage,
    }))
  }
  if (failure.kind === "rate_limited") {
    rememberQuota(failure.quota)
    set({ banner: { kind: "rate_limited", message: limitMessage(failure.quota) } })
  } else if (failure.kind === "not_configured" || failure.kind === "unavailable") {
    set({ banner: { kind: failure.kind, message: failure.message } })
  } else {
    finishActivity()
    updateBot((m) => ({ ...m, streaming: false, failed: true, content: m.content ? `${m.content}\n\n_${failure.message}_` : failure.message }))
  }
}

export function sendDevonAi(input: string) {
  const text = input.trim()
  if (!text || state.loading || !state.started) return
  const conversationId = state.conversationId
  const page = state.pendingPage ?? undefined
  snapshotArmed = true

  const userMsg: Message = {
    id: uuid(),
    role: "user",
    content: text,
    timestamp: Date.now(),
    ...(page ? { page: { url: page.url, title: page.title } } : {}),
  }
  botMsgId = uuid()
  const thisBot = botMsgId
  const botMsg: Message = { id: thisBot, role: "assistant", content: "", timestamp: Date.now(), streaming: true }

  const title = text.replace(/\s+/g, " ").trim()
  set((s) => {
    const others = s.conversations.filter((c) => c.id !== conversationId)
    const existing = s.conversations.find((c) => c.id === conversationId)
    const summary: ConversationSummary = existing
      ? { ...existing, lastMessageAt: Date.now() }
      : { id: conversationId, title: title.length > 40 ? `${title.slice(0, 40)}…` : title, lastMessageAt: Date.now(), userId: s.userId }
    return {
      messages: [...s.messages, userMsg, botMsg],
      loading: true,
      pendingPage: null,
      banner: s.banner?.kind === "notice" || s.banner?.kind === "error" ? null : s.banner,
      conversations: [summary, ...others],
    }
  })

  const finish = () => {
    if (botMsgId === thisBot) {
      abortCtrl = null
      set({ loading: false })
    }
  }

  abortCtrl = sendMessageStream(
    { message: text, conversationId, userId: state.userId, userMsgId: userMsg.id, botMsgId: thisBot, page },
    {
      onQuota: (quota) => rememberQuota(quota),
      onTextDelta(delta) {
        finishActivity()
        updateBot((m) => ({ ...m, content: m.content + delta }))
      },
      onToolCalled(tool) {
        updateBot((m) => ({ ...m, activity: { ...toolLabels(tool), status: "active" } }))
      },
      onSkillLoaded(name) {
        updateBot((m) => ({ ...m, activity: { label: `Using the ${name} skill`, doneLabel: `Used the ${name} skill`, status: "active" } }))
      },
      onImage(payload) {
        finishActivity()
        void handleImage(payload, conversationId, thisBot)
      },
      onNotice(_code, message) {
        updateBot((m) => (m.activity ? { ...m, activity: { label: message, status: "error" } } : m))
        set({ banner: { kind: "notice", message } })
      },
      onDone() {
        finishActivity()
        updateBot((m) => ({ ...m, streaming: false }))
        finish()
        void refreshConversations("replace")
      },
      onFail(failure) {
        applyFailure(failure, userMsg.id, text, page)
        finish()
      },
    },
  )
}

export function stopDevonAi() {
  if (!state.loading) return
  abortCtrl?.abort()
  abortCtrl = null
  finishActivity()
  updateBot((m) => ({ ...m, streaming: false, content: m.content ? `${m.content}\n\n_Stopped._` : "_Stopped._" }))
  set({ loading: false })
  void stopAgent(state.conversationId)
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function switchTo(conversationId: string, load: boolean) {
  writeStorage(CONVERSATION_KEY, conversationId)
  revokeAllObjectUrls()
  snapshotArmed = false
  set({ conversationId, messages: [], historyLoading: false })
  if (load) void loadConversation(conversationId)
}

export function newDevonAiChat() {
  if (state.loading) return
  loadToken++
  switchTo(uuid(), false)
}

export function selectDevonAiChat(id: string) {
  if (state.loading || id === state.conversationId) return
  switchTo(id, true)
}

export function deleteDevonAiChat(id: string) {
  if (state.loading || !id) return
  const wasActive = id === state.conversationId
  set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) }))
  if (wasActive) {
    loadToken++
    switchTo(uuid(), false)
  }
  void deleteSnapshot(id)
  void deleteConversationImages(id).catch(() => {})
  void deleteConversationApi(id, state.userId)
}

export function loadMoreDevonAiChats() {
  if (!state.nextCursor || state.loadingMore) return
  void refreshConversations("append")
}

// ---------------------------------------------------------------------------
// From other parts of Devon
// ---------------------------------------------------------------------------

/** Attach a page to the next question (the page chip above the input) */
export function attachPageToDevonAi(page: PageContext | null) {
  set({ pendingPage: page })
}

/**
 * "Ask Devon AI about this page": a fresh chat with the page attached. If a
 * reply is still streaming, the page attaches to the current chat instead.
 */
export function askDevonAiAboutPage(page: PageContext) {
  startDevonAi()
  if (!state.loading && (state.messages.length > 0 || state.historyLoading)) newDevonAiChat()
  set({ pendingPage: page })
}

/** Put text in Devon AI's input box (Prompt Gen's "Send to Devon AI") */
export function setDevonAiDraft(text: string) {
  set((s) => ({ draft: text, draftVersion: s.draftVersion + 1 }))
}

export function dismissDevonAiBanner() {
  set({ banner: null })
}
