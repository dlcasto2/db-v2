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
  page?: PageRef
  /** The tool the assistant is using right now (shown as a chip until text arrives) */
  activity?: { label: string; doneLabel?: string; status: "active" | "done" | "error" }
  /** True while this reply is still streaming */
  streaming?: boolean
  /** The reply failed; content holds the reason */
  failed?: boolean
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
