/**
 * Devon AI chat types. Adapted from TencentEdgeOne/claude-agent-starter-node (MIT).
 */

/** A tool image (screenshot, chart) kept in IndexedDB; `url` is a blob: URL made at runtime */
export interface ImageAttachment {
  id: string
  /** `${conversationId}/${id}` */
  storageKey: string
  url: string
  mimeType: string
  size: number
  createdAt: number
  /** Saved to IndexedDB (survives a reload) */
  persistent: boolean
}

export interface ImageSsePayload {
  imageId: string
  base64: string
  mimeType?: string
  size?: number
}

/** The page a question was about */
export interface PageRef {
  url: string
  title: string
}

/** Page sent along with a question: its address, title and visible text */
export interface PageContext extends PageRef {
  text: string
}

export interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: number
  images?: ImageAttachment[]
  files?: UploadedFileInfo[]
  page?: PageRef
  /** Tools and page actions used in this reply, in order */
  actions?: ActionStep[]
  /** True while this reply is still streaming */
  streaming?: boolean
  /** The reply failed; content holds the reason */
  failed?: boolean
  /** The visitor's thumbs up/down on this reply, once sent */
  feedback?: FeedbackRating
}

export interface UploadedFileInfo {
  name: string
  path: string
  mimeType: string
  size: number
}

/** Text extracted from a user-selected file; file content is sent only with the current request. */
export interface UploadedFile extends UploadedFileInfo {
  text: string
}

export interface ConversationSummary {
  id: string
  title: string
  preview?: string
  lastMessageAt?: number
  createdAt?: number
  userId?: string
  messageCount?: number
}

export interface ListConversationsResponse {
  conversations: ConversationSummary[]
  nextCursor?: string
  previousCursor?: string
}

export interface Quota {
  used: number
  /** 0 = unlimited */
  limit: number
  resetAt: number
}

/** One tool use or page action shown in a reply */
export interface ActionStep {
  /** The page action's call ID, or tool:<name> while only the tool name is known */
  id: string
  label: string
  doneLabel: string
  status: "active" | "done" | "error"
  /** Why it failed or was declined */
  note?: string
}

/** A chat's session state, kept by the agent (agents/_session.ts) */
export interface SessionState {
  task: string
  steps: { text: string; done: boolean }[]
  notes: string[]
  openQuestions: string[]
  pages: { url: string; title: string; at: number; state?: string }[]
  updatedAt: number
}

/** Devon's side of the session, sent with each message */
export interface BrowserSession {
  tabs: { id: string; title: string; url: string; active: boolean }[]
  target: string | null
  /** Browser-local notes that survive across chats on this device */
  memoryNotes?: string[]
  /** Small snapshots reused across chats to avoid reading the same page again */
  recentReads?: { url: string; title: string; text: string }[]
}

/** A page action waiting for the visitor's OK */
export interface PendingApproval {
  callId: string
  site: string
  description: string
  /** Looks hard to undo (buying, paying, deleting, sending…) — always asked fresh, even on an already-allowed site */
  irreversible: boolean
  warning?: string
}

export type FeedbackRating = "up" | "down"
export type FeedbackReasonCode = "wrong_fact" | "misread_page" | "bad_action" | "other"
