/**
 * Redis-backed stand-in for EdgeOne's `AgentMemory` (private module, not a route).
 *
 * agents/_quota.ts, agents/_mailbox.ts, agents/_session.ts, agents/ai-chat/_stream.ts
 * and agents/ai-chat/_devon-tools.ts are written against `Pick<AgentMemory, ...>`
 * shapes, not against EdgeOne itself — they only ever call appendMessage,
 * getMessages, deleteMessage, clearMessages and state.get/set/delete. Anything
 * that satisfies those five method shapes can stand in for `context.store`, so
 * this file is the ONLY new piece those modules need: give them one of these and
 * Devon AI's quota, mailbox, session and chat-saving logic runs unchanged on
 * Vercel, with zero risk to the EdgeOne deployment (nothing under agents/ is
 * modified except two type annotations — see the comments in _devon-tools.ts and
 * _stream.ts — that only *narrow* what they require, never what EdgeOne provides).
 *
 * Conversations are stored the same way EdgeOne's quota/mailbox code already
 * treats its own counters: as "messages" in a keyed bucket. Each conversation
 * gets a Redis hash of messageId -> JSON (the message) and a sorted set of
 * messageId ordered by when it was written, so getMessages can page either
 * direction without re-sorting on every read.
 *
 * Ephemeral buckets (dq-* quota counters, dt-* page-action mailboxes) get a
 * short TTL refreshed on every write, so an abandoned visitor ID or a chat
 * that's never revisited doesn't sit in Redis forever. Real conversations
 * (chat history, session state) never expire.
 */

import { redis } from "./kv"

type Json = Record<string, unknown>

/** Matches EdgeOne's MemoryRole/MemoryContent so this store satisfies the same Pick<AgentMemory, ...> shapes */
export type StoredRole = "user" | "assistant" | "system" | "tool"
export type StoredContent = string | unknown[] | Record<string, unknown>

export interface StoredMessage {
  messageId: string
  role: StoredRole
  content: StoredContent
  metadata?: Json
  userId?: string
  createdAt: number
}

const QUOTA_TTL_SECONDS = 2 * 24 * 60 * 60 // a quota counter only matters for ~1 UTC day
const MAILBOX_TTL_SECONDS = 15 * 60 // a mailbox entry only matters for one waiting tool call

function ephemeralTtl(conversationId: string): number | null {
  if (conversationId.startsWith("dq-")) return QUOTA_TTL_SECONDS
  if (conversationId.startsWith("dt-")) return MAILBOX_TTL_SECONDS
  return null
}

function msgsKey(conversationId: string): string {
  return `devon:conv:${conversationId}:msgs`
}
function orderKey(conversationId: string): string {
  return `devon:conv:${conversationId}:order`
}
function metaKey(conversationId: string): string {
  return `devon:conv:${conversationId}:meta`
}
function stateKey(conversationId: string, key: string): string {
  return `devon:conv:${conversationId}:state:${key}`
}
function userConvsKey(userId: string): string {
  return `devon:user:${userId}:convs`
}

type ScoreBound = number | `(${number}` | "-inf" | "+inf"
/** An exclusive score bound for ZRANGE's byScore mode, typed the way @upstash/redis wants it */
function exclusive(score: number): `(${number}` {
  return `(${score}`
}

export interface AppendMessageInput {
  conversationId: string
  role: StoredRole
  content: StoredContent
  metadata?: Json
  userId?: string
  messageId?: string
}

export interface GetMessagesInput {
  conversationId: string
  limit?: number
  order?: "asc" | "desc"
  userId?: string
}

export interface DeleteMessageInput {
  conversationId: string
  messageId: string
}

export interface ConversationIdInput {
  conversationId: string
  userId?: string
}

export interface ListConversationsInput {
  userId: string
  limit?: number
  order?: "asc" | "desc"
  after?: string
  before?: string
}

export interface ConversationSummaryRaw {
  id: string
  lastMessageAt?: number
  createdAt?: number
  userId?: string
  firstUserMessage?: string
}

export interface ListConversationsResult {
  items: ConversationSummaryRaw[]
  nextCursor?: string
  previousCursor?: string
}

/** A store scoped to one conversation for `state`, generic everywhere else (matches how EdgeOne's context.store behaves) */
export function createAiStore(boundConversationId: string) {
  return {
    async appendMessage(input: AppendMessageInput): Promise<string> {
      const r = redis()
      const messageId = input.messageId || crypto.randomUUID()
      if (!r) return messageId // no store configured: let the caller proceed as if it saved
      const createdAt = Date.now()
      const stored: StoredMessage = {
        messageId,
        role: input.role,
        content: input.content,
        createdAt,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
      }
      const mKey = msgsKey(input.conversationId)
      const oKey = orderKey(input.conversationId)
      await Promise.all([
        r.hset(mKey, { [messageId]: JSON.stringify(stored) }),
        r.zadd(oKey, { score: createdAt, member: messageId }),
      ])
      const ttl = ephemeralTtl(input.conversationId)
      if (ttl) await Promise.all([r.expire(mKey, ttl), r.expire(oKey, ttl)])
      else if (input.userId) {
        // Touch the owner's conversation index so it sorts by latest activity
        await r.zadd(userConvsKey(input.userId), { score: createdAt, member: input.conversationId })
        await r.hset(metaKey(input.conversationId), {
          userId: input.userId,
          createdAt: String((await r.hget<string>(metaKey(input.conversationId), "createdAt")) || createdAt),
        })
      }
      return messageId
    },

    async getMessages(input: GetMessagesInput): Promise<StoredMessage[]> {
      const r = redis()
      if (!r) return []
      const oKey = orderKey(input.conversationId)
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 500)
      const ids =
        input.order === "asc"
          ? await r.zrange<string[]>(oKey, 0, limit - 1)
          : await r.zrange<string[]>(oKey, 0, limit - 1, { rev: true })
      if (!ids.length) return []
      const raw = await r.hmget<Record<string, string>>(msgsKey(input.conversationId), ...ids)
      const out: StoredMessage[] = []
      for (const id of ids) {
        const json = raw?.[id]
        if (!json) continue
        try {
          const msg = JSON.parse(json) as StoredMessage
          if (input.userId && msg.userId && msg.userId !== input.userId) continue
          out.push(msg)
        } catch {
          // skip unparsable entries rather than failing the whole read
        }
      }
      return out
    },

    async deleteMessage(input: DeleteMessageInput): Promise<void> {
      const r = redis()
      if (!r) return
      await Promise.all([
        r.hdel(msgsKey(input.conversationId), input.messageId),
        r.zrem(orderKey(input.conversationId), input.messageId),
      ])
    },

    async clearMessages(input: ConversationIdInput): Promise<void> {
      const r = redis()
      if (!r) return
      await Promise.all([r.del(msgsKey(input.conversationId)), r.del(orderKey(input.conversationId))])
    },

    async deleteConversation(input: ConversationIdInput): Promise<void> {
      const r = redis()
      if (!r) return
      const owner = input.userId || (await r.hget<string>(metaKey(input.conversationId), "userId")) || undefined
      await Promise.all([
        r.del(msgsKey(input.conversationId)),
        r.del(orderKey(input.conversationId)),
        r.del(metaKey(input.conversationId)),
        owner ? r.zrem(userConvsKey(owner), input.conversationId) : Promise.resolve(),
      ])
    },

    async listConversations(input: ListConversationsInput): Promise<ListConversationsResult> {
      const r = redis()
      if (!r) return { items: [] }
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
      const key = userConvsKey(input.userId)
      const desc = input.order !== "asc"
      // Fetch one extra to know whether another page follows
      const afterScore = input.after ? Number(input.after) : undefined
      const beforeScore = input.before ? Number(input.before) : undefined
      let ids: string[]
      if (desc) {
        const max: ScoreBound = beforeScore !== undefined ? exclusive(beforeScore) : "+inf"
        const min: ScoreBound = afterScore !== undefined ? exclusive(afterScore) : "-inf"
        ids = await r.zrange<string[]>(key, max, min, { byScore: true, rev: true, offset: 0, count: limit + 1 })
      } else {
        const min: ScoreBound = afterScore !== undefined ? exclusive(afterScore) : "-inf"
        const max: ScoreBound = beforeScore !== undefined ? exclusive(beforeScore) : "+inf"
        ids = await r.zrange<string[]>(key, min, max, { byScore: true, offset: 0, count: limit + 1 })
      }
      const hasMore = ids.length > limit
      const page = hasMore ? ids.slice(0, limit) : ids
      if (!page.length) return { items: [] }

      const scores = await Promise.all(page.map((id) => r.zscore(key, id)))
      const metas = await Promise.all(page.map((id) => r.hgetall<Record<string, string>>(metaKey(id))))
      const items: ConversationSummaryRaw[] = await Promise.all(
        page.map(async (id, i) => {
          const firstIds = await r.zrange<string[]>(orderKey(id), 0, 0)
          let firstUserMessage: string | undefined
          if (firstIds[0]) {
            const json = await r.hget<string>(msgsKey(id), firstIds[0])
            if (json) {
              try {
                const msg = JSON.parse(json) as StoredMessage
                if (msg.role === "user" && typeof msg.content === "string") firstUserMessage = msg.content
              } catch {
                // leave firstUserMessage unset
              }
            }
          }
          const meta = metas[i]
          return {
            id,
            lastMessageAt: Number(scores[i]) || undefined,
            createdAt: meta?.createdAt ? Number(meta.createdAt) : undefined,
            userId: meta?.userId || input.userId,
            firstUserMessage,
          }
        }),
      )

      return {
        items,
        nextCursor: hasMore ? String(scores[scores.length - 1]) : undefined,
      }
    },

    state: {
      async get<T = unknown>(key: string): Promise<T | null> {
        const r = redis()
        if (!r) return null
        const value = await r.get<T>(stateKey(boundConversationId, key))
        return value ?? null
      },
      async set<T = unknown>(key: string, value: T): Promise<void> {
        const r = redis()
        if (!r) return
        await r.set(stateKey(boundConversationId, key), value)
      },
      async delete(key: string): Promise<void> {
        const r = redis()
        if (!r) return
        await r.del(stateKey(boundConversationId, key))
      },
    },
  }
}

export type AiStore = ReturnType<typeof createAiStore>
