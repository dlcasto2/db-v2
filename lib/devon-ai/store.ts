"use client"

/**
 * Devon AI's chat state, kept outside React.
 *
 * Devon only renders the active tab's internal page, so the Devon AI page
 * unmounts whenever you switch tabs. Keeping the conversation, the running
 * stream and the sidebar here means a reply keeps arriving in the background
 * and is there when you come back. The logic follows the starter's App.tsx
 * (TencentEdgeOne/claude-agent-starter-node, MIT).
 *
 * It also runs Devon AI's page actions: the agent sends `page_action` events,
 * this file asks the visitor's permission where needed, runs them through the
 * PageHost the browser registers (page-executor.ts) and posts the results
 * back. And it keeps the chat's session state: the agent's task, steps and
 * notes (from the server) plus the sites the visitor allowed in this chat.
 */

import { useSyncExternalStore } from "react"
import {
  type ChatFailure,
  clearSessionApi,
  deleteConversation as deleteConversationApi,
  fetchConversationHistory,
  fetchSession,
  listConversations,
  postPageResult,
  sendMessageStream,
  stopAgent,
} from "@/lib/devon-ai/api"
import { type PageActionRequest, type PageHost, runPageAction, siteOf } from "@/lib/devon-ai/page-executor"
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
import type {
  ActionStep,
  BrowserSession,
  ConversationSummary,
  ImageAttachment,
  ImageSsePayload,
  Message,
  PageContext,
  PendingApproval,
  Quota,
  SessionState,
} from "@/lib/devon-ai/types"

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
  /** This chat's session state from the agent: task, steps, notes, pages used */
  session: SessionState | null
  /** Sites the visitor let Devon AI click and type on in this chat */
  allowedSites: string[]
  /** A page action waiting for the visitor's OK */
  approval: PendingApproval | null
  /** While Devon AI works on a tab: which one, and what it's doing */
  pageWork: { tabId: string | null; label: string } | null
}

const CONVERSATION_KEY = "devon_ai_conversation"
const USER_KEY = "devon_ai_uid"
const QUOTA_KEY = "devon_ai_quota"
const SITES_KEY = "devon_ai_sites"
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
  session: null,
  allowedSites: [],
  approval: null,
  pageWork: null,
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

/** Only what the browser chrome needs (changes rarely, unlike the chat while it streams) */
export function useDevonAiPageWork(): ChatState["pageWork"] {
  return useSyncExternalStore(
    subscribe,
    () => (state.loading ? state.pageWork : null),
    () => null,
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
// Allowed sites (per chat, kept in this browser)
// ---------------------------------------------------------------------------

function readSites(): Record<string, string[]> {
  try {
    const raw = JSON.parse(readStorage(SITES_KEY) || "{}") as Record<string, unknown>
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string")
    return out
  } catch {
    return {}
  }
}

function sitesFor(conversationId: string): string[] {
  return readSites()[conversationId] ?? []
}

function writeSites(conversationId: string, sites: string[]) {
  const all = readSites()
  delete all[conversationId]
  if (sites.length) all[conversationId] = sites
  // Keep the 50 most recently changed chats
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k]
  writeStorage(SITES_KEY, JSON.stringify(all))
  if (conversationId === state.conversationId) set({ allowedSites: sites })
}

export function removeAllowedSite(site: string) {
  writeSites(state.conversationId, state.allowedSites.filter((s) => s !== site))
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
/** Last session state seen per chat, for runtimes where /ai-session can't answer */
const sessionCache = new Map<string, SessionState | null>()

function setSession(conversationId: string, session: SessionState | null) {
  sessionCache.set(conversationId, session)
  if (conversationId === state.conversationId) set({ session })
}

async function loadSessionFor(conversationId: string) {
  const { session, available } = await fetchSession(conversationId)
  if (available) setSession(conversationId, session)
}

async function loadConversation(conversationId: string) {
  const token = ++loadToken
  snapshotArmed = false
  revokeAllObjectUrls()
  set({ historyLoading: true, messages: [] })
  void loadSessionFor(conversationId)
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
  set({ started: true, userId, conversationId, quota: savedQuota(), allowedSites: sitesFor(conversationId) })
  void refreshConversations("replace")
  if (existing) void loadConversation(conversationId)
}

// ---------------------------------------------------------------------------
// Tool steps shown in a reply
// ---------------------------------------------------------------------------

let abortCtrl: AbortController | null = null
let botMsgId = ""

/** Step text while a tool runs, and once it's done */
const TOOL_LABELS: [RegExp, string, string][] = [
  [/^session_update$/i, "Updating the session", "Updated the session"],
  [/^(page_|tab_|tabs_)/i, "Working on the page", "Worked on the page"],
  [/^(web_search|search)/i, "Searching the web", "Searched the web"],
  [/^browser|browse/i, "Browsing the web (sandbox)", "Browsed the web (sandbox)"],
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

function short(s: unknown, max = 40): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** What a page action is doing, in words */
function actionLabels(req: PageActionRequest): { label: string; doneLabel: string } {
  const a = req.args
  const element = short(a.element) || "an element"
  switch (req.tool) {
    case "tabs_list":
      return { label: "Checking your tabs", doneLabel: "Checked your tabs" }
    case "tab_open":
      return { label: `Opening ${siteOf(String(a.url || ""))}`, doneLabel: `Opened ${siteOf(String(a.url || ""))}` }
    case "tab_select":
      return { label: "Switching tabs", doneLabel: "Switched tabs" }
    case "page_read":
      return a.query
        ? { label: `Looking for “${short(a.query)}”`, doneLabel: `Looked for “${short(a.query)}”` }
        : { label: "Reading the page", doneLabel: "Read the page" }
    case "page_click":
      return { label: `Clicking ${element}`, doneLabel: `Clicked ${element}` }
    case "page_type":
      return { label: `Typing into ${element}`, doneLabel: `Typed into ${element}` }
    case "page_select":
      return { label: `Choosing “${short(a.option)}”`, doneLabel: `Chose “${short(a.option)}”` }
    case "page_scroll":
      return { label: "Scrolling", doneLabel: "Scrolled" }
    case "page_navigate": {
      const to = String(a.to || "")
      if (/^(back|forward|reload)$/i.test(to)) {
        const w = to.toLowerCase()
        return w === "reload" ? { label: "Reloading", doneLabel: "Reloaded" } : { label: `Going ${w}`, doneLabel: `Went ${w}` }
      }
      return { label: `Opening ${siteOf(to)}`, doneLabel: `Opened ${siteOf(to)}` }
    }
    default:
      return toolLabels(req.tool)
  }
}

function updateBot(fn: (m: Message) => Message, id = botMsgId) {
  set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) }))
}

function addStep(step: ActionStep, id = botMsgId) {
  updateBot((m) => ({ ...m, actions: [...(m.actions ?? []), step] }), id)
}

function updateStep(stepId: string, fn: (s: ActionStep) => ActionStep, id = botMsgId) {
  updateBot((m) => ({ ...m, actions: (m.actions ?? []).map((s) => (s.id === stepId ? fn(s) : s)) }), id)
}

/** Sandbox tools have no result event: they're done once anything else arrives */
function finishToolSteps(id = botMsgId) {
  updateBot(
    (m) =>
      m.actions?.some((s) => s.status === "active" && s.id.startsWith("tool:"))
        ? { ...m, actions: m.actions.map((s) => (s.status === "active" && s.id.startsWith("tool:") ? { ...s, status: "done" } : s)) }
        : m,
    id,
  )
}

/** Any step still spinning when the reply ends */
function settleSteps(id = botMsgId, status: "done" | "error" = "done") {
  updateBot((m) => (m.actions?.some((s) => s.status === "active") ? { ...m, actions: m.actions.map((s) => (s.status === "active" ? { ...s, status } : s)) } : m), id)
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

// ---------------------------------------------------------------------------
// Page actions
// ---------------------------------------------------------------------------

let pageHost: PageHost | null = null
let actionChain: Promise<void> = Promise.resolve()
let runStopped = false
let approvalResolve: ((ok: boolean) => void) | null = null

/** The browser registers how to reach its tabs; returns an unregister function */
export function registerPageHost(host: PageHost): () => void {
  pageHost = host
  return () => {
    if (pageHost === host) pageHost = null
  }
}

function browserSession(): BrowserSession | undefined {
  if (!pageHost) return undefined
  try {
    return {
      tabs: pageHost.tabs().map(({ id, title, url, active }) => ({ id, title, url, active })),
      target: pageHost.defaultTarget(),
    }
  } catch {
    return undefined
  }
}

function askApproval(callId: string, site: string, description: string, conversationId: string): Promise<boolean> {
  if (sitesFor(conversationId).includes(site)) return Promise.resolve(true)
  if (runStopped) return Promise.resolve(false)
  approvalResolve?.(false)
  return new Promise((resolve) => {
    approvalResolve = (ok) => {
      approvalResolve = null
      set({ approval: null })
      resolve(ok)
    }
    set({ approval: { callId, site, description } })
  })
}

/** The visitor's answer to the permission card */
export function respondDevonAiApproval(choice: "once" | "site" | "deny") {
  const pending = state.approval
  if (!pending || !approvalResolve) return
  if (choice === "site") writeSites(state.conversationId, [...new Set([...state.allowedSites, pending.site])])
  approvalResolve(choice !== "deny")
}

function handlePageAction(req: PageActionRequest, conversationId: string, messageId: string) {
  const labels = actionLabels(req)
  // The tool_called step for this tool becomes the specific action
  updateBot((m) => {
    const steps = [...(m.actions ?? [])]
    const generic = steps.findIndex((s) => s.id === `tool:${req.tool}` && s.status === "active")
    const step: ActionStep = { id: req.callId, ...labels, status: "active" }
    if (generic >= 0) steps[generic] = step
    else steps.push(step)
    return { ...m, actions: steps }
  }, messageId)

  actionChain = actionChain.then(async () => {
    const host = pageHost
    if (host) set({ pageWork: { tabId: host.defaultTarget(), label: labels.label } })
    const outcome = host
      ? await runPageAction(host, req, {
          approve: (site, description) => askApproval(req.callId, site, description, conversationId),
          stopped: () => runStopped,
        })
      : { ok: false, text: "Devon's page tools aren't available right now. Ask the user to reload Devon." }
    if (host && state.pageWork) set({ pageWork: { tabId: outcome.tab?.id ?? host.defaultTarget(), label: labels.doneLabel } })
    updateStep(
      req.callId,
      (s) => ({ ...s, status: outcome.ok ? "done" : "error", ...(outcome.ok ? {} : { note: short(outcome.text.split("\n")[0], 140) }) }),
      messageId,
    )
    if (!runStopped) await postPageResult(conversationId, req.callId, outcome)
  })
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

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
function applyFailure(failure: ChatFailure, userMsgId: string, messageId: string, text: string, page: PageContext | undefined) {
  // The request never reached the model: take the question back out and put it in the input again
  const withdraw = failure.kind !== "error"
  if (withdraw) {
    set((s) => ({
      messages: s.messages.filter((m) => m.id !== userMsgId && m.id !== messageId),
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
    settleSteps(messageId, "error")
    updateBot(
      (m) => ({ ...m, streaming: false, failed: true, content: m.content ? `${m.content}\n\n_${failure.message}_` : failure.message }),
      messageId,
    )
  }
}

/** The run is over: release any waiting permission card and the "using this tab" strip */
function endRun() {
  approvalResolve?.(false)
  set({ pageWork: null })
}

export function sendDevonAi(input: string) {
  const text = input.trim()
  if (!text || state.loading || !state.started) return
  const conversationId = state.conversationId
  const page = state.pendingPage ?? undefined
  snapshotArmed = true
  runStopped = false

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
      endRun()
    }
  }

  abortCtrl = sendMessageStream(
    {
      message: text,
      conversationId,
      userId: state.userId,
      userMsgId: userMsg.id,
      botMsgId: thisBot,
      page,
      browser: browserSession(),
    },
    {
      onQuota: (quota) => rememberQuota(quota),
      onSession: (session) => setSession(conversationId, session),
      onTextDelta(delta) {
        finishToolSteps(thisBot)
        updateBot((m) => ({ ...m, content: m.content + delta }), thisBot)
      },
      onToolCalled(tool) {
        finishToolSteps(thisBot)
        addStep({ id: `tool:${tool}`, ...toolLabels(tool), status: "active" }, thisBot)
      },
      onSkillLoaded(name) {
        updateStep(`tool:Skill`, (s) => ({ ...s, label: `Loading the ${name} skill`, doneLabel: `Loaded the ${name} skill` }), thisBot)
      },
      onPageAction(req) {
        handlePageAction(req, conversationId, thisBot)
      },
      onImage(payload) {
        finishToolSteps(thisBot)
        void handleImage(payload, conversationId, thisBot)
      },
      onNotice(_code, message) {
        updateBot(
          (m) => {
            const steps = [...(m.actions ?? [])]
            const last = steps.length - 1
            if (last >= 0 && steps[last].id.startsWith("tool:")) steps[last] = { ...steps[last], status: "error", note: message }
            return { ...m, actions: steps }
          },
          thisBot,
        )
        set({ banner: { kind: "notice", message } })
      },
      onDone() {
        settleSteps(thisBot)
        updateBot((m) => ({ ...m, streaming: false }), thisBot)
        finish()
        void refreshConversations("replace")
      },
      onFail(failure) {
        applyFailure(failure, userMsg.id, thisBot, text, page)
        finish()
      },
    },
  )
}

export function stopDevonAi() {
  if (!state.loading) return
  runStopped = true
  abortCtrl?.abort()
  abortCtrl = null
  settleSteps(botMsgId, "error")
  updateBot((m) => ({ ...m, streaming: false, content: m.content ? `${m.content}\n\n_Stopped._` : "_Stopped._" }))
  set({ loading: false })
  endRun()
  void stopAgent(state.conversationId)
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

function switchTo(conversationId: string, load: boolean) {
  writeStorage(CONVERSATION_KEY, conversationId)
  revokeAllObjectUrls()
  snapshotArmed = false
  set({
    conversationId,
    messages: [],
    historyLoading: false,
    session: sessionCache.get(conversationId) ?? null,
    allowedSites: sitesFor(conversationId),
  })
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
  writeSites(id, [])
  sessionCache.delete(id)
  void deleteSnapshot(id)
  void deleteConversationImages(id).catch(() => {})
  void deleteConversationApi(id, state.userId)
}

export function loadMoreDevonAiChats() {
  if (!state.nextCursor || state.loadingMore) return
  void refreshConversations("append")
}

/** Forget this chat's session: the agent's task, steps and notes, and the sites allowed in it */
export function clearDevonAiSession() {
  const id = state.conversationId
  setSession(id, null)
  writeSites(id, [])
  void clearSessionApi(id)
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
