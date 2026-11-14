/**
 * Devon AI chat types. Adapted from TencentEdgeOne/claude-agent-starter-node (MIT).
 */

export type DevonAiModel = "claude" | "eve" | "airllm"

/** A stored or received provider choice, falling back to Claude for anything unknown */
export function toDevonAiModel(value: unknown): DevonAiModel {
  return value === "eve" || value === "airllm" ? value : "claude"
}

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
  /** Clickable next-step options the assistant offered after finishing a task */
  suggestedActions?: SuggestedAction[]
  /** Files the assistant generated and delivered for download */
  generatedFiles?: GeneratedFile[]
  /** True while this reply is still streaming */
  streaming?: boolean
  /** The reply failed; content holds the reason */
  failed?: boolean
  /** The visitor's thumbs up/down on this reply, once sent */
  feedback?: FeedbackRating
}

/** One clickable option in a suggest_actions card */
export interface SuggestedAction {
  id: string
  emoji: string
  title: string
  description: string
}

/** A file the assistant delivered for download (deliver_file); the bytes live in IndexedDB, keyed like ImageAttachment */
export interface GeneratedFile {
  id: string
  storageKey: string
  url: string
  name: string
  mimeType: string
  size: number
  description?: string
  createdAt: number
  /** Saved to IndexedDB (survives a reload); false if only a sandbox download link was offered instead */
  persistent: boolean
}

/** suggest_actions SSE payload */
export interface SuggestActionsSsePayload {
  actions: SuggestedAction[]
}

/** file_output SSE payload: a generated file pushed inline, base64-encoded */
export interface FileOutputSsePayload {
  fileId: string
  base64: string
  filename: string
  mimeType?: string
  size?: number
  description?: string
}

export interface UploadedFileInfo {
  name: string
  path: string
  mimeType: string
  size: number
  /** Image, PDF, Word or Excel — written into the sandbox rather than inlined as text; see lib/devon-ai/uploads.ts */
  binary?: boolean
}

/**
 * A user-selected file; content is sent only with the current request.
 * Text files carry extracted text in `text`. Binary files (images, PDF,
 * Word, Excel) carry base64-encoded bytes in `base64` instead, with `text`
 * left empty — their content is written into the sandbox, never inlined
 * into the prompt (see lib/devon-ai/uploads.ts's uploadedFilesBlock).
 */
export interface UploadedFile extends UploadedFileInfo {
  text: string
  base64?: string
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
