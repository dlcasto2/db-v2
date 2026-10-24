/**
 * Devon AI conversation list — EdgeOne Makers Node Function
 * ===================================================
 *
 * File path cloud-functions/ai-conversations/index.ts maps to **POST /ai-conversations**.
 * From TencentEdgeOne/claude-agent-starter-node (MIT).
 *
 * Lists conversations belonging to the requesting user (`eo-uuid`).
 * Calls `context.agent!.store.listConversations({ userId, limit, order, after, before })`,
 * then normalizes the runtime result into a stable shape for the frontend:
 *
 * Response:
 *   {
 *     conversations: ConversationSummary[],
 *     nextCursor?: string,
 *     previousCursor?: string,
 *   }
 *
 * NOTE: The frontend MUST send `user_id` (or `userId`). Without a user namespace
 * we refuse to leak conversations across users and return 400.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';

const logger = createLogger('ai-conversations');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

type Order = 'asc' | 'desc';

interface NormalizedConversation {
  id: string;
  title: string;
  preview?: string;
  lastMessageAt?: number;
  createdAt?: number;
  userId?: string;
  messageCount?: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJsonBody(context: CloudFunctionContext): Promise<Record<string, unknown>> {
  try {
    const data = await context.request!.json();
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pickString(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function clampLimit(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(raw)));
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
    }
  }
  return DEFAULT_LIMIT;
}

function pickOrder(raw: unknown): Order {
  return raw === 'asc' ? 'asc' : 'desc';
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Best-effort string extraction from a message `content` field.
 * Handles plain strings, arrays of {text}, and nested {text}/{content} objects.
 */
function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string' && item.trim()) return item;
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
        if (typeof obj.output_text === 'string' && obj.output_text.trim()) return obj.output_text;
      }
    }
    return '';
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
    if ('content' in obj) return messageContentToText(obj.content);
    if ('output' in obj) return messageContentToText(obj.output);
  }
  return '';
}

const TITLE_SNIPPET_MAX = 40;

/**
 * Build a conversation title from the first user question (ChatGPT-style — no prefix).
 * - Trims whitespace and collapses internal runs to a single space.
 * - Truncates to TITLE_SNIPPET_MAX characters with an ellipsis when needed.
 * - Falls back to `New chat` when no user message exists yet.
 */
function buildTitleFromFirstMessage(firstQuestion: string): string {
  const cleaned = firstQuestion.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  if (cleaned.length <= TITLE_SNIPPET_MAX) return cleaned;
  return `${cleaned.slice(0, TITLE_SNIPPET_MAX)}...`;
}

/**
 * Try to extract the first user question text from a conversation summary returned
 * by the runtime. EdgeOne `listConversations` may already include a first-message
 * field — using it avoids an extra getMessages round-trip.
 */
function pickFirstQuestionFromSummary(item: Record<string, unknown>): string {
  const candidates = [
    item.firstUserMessage,
    item.first_user_message,
    item.firstMessage,
    item.first_message,
  ];
  for (const cand of candidates) {
    const text = messageContentToText(cand);
    if (text.trim()) return text;
  }
  return '';
}

function normalizeConversation(raw: unknown, injectedFirstQuestion?: string): NormalizedConversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const id = pickString(item, 'id', 'conversationId', 'conversation_id');
  if (!id) return null;

  // Title priority:
  //   1. explicit `title`/`name`/`subject` from the runtime
  //   2. first user question (already on the summary or fetched separately)
  //   3. fallback "New chat"
  const explicitTitle = pickString(item, 'title', 'name', 'subject');
  const firstQuestion =
    injectedFirstQuestion?.trim() ||
    pickFirstQuestionFromSummary(item);
  const title = explicitTitle || buildTitleFromFirstMessage(firstQuestion);

  const preview = pickString(item, 'preview', 'lastMessage', 'last_message', 'snippet', 'summary') || undefined;

  const lastMessageAt =
    timestampOf(item.lastMessageAt) ??
    timestampOf(item.last_message_at) ??
    timestampOf(item.updatedAt) ??
    timestampOf(item.updated_at);

  const createdAt =
    timestampOf(item.createdAt) ??
    timestampOf(item.created_at);

  const userId = pickString(item, 'userId', 'user_id') || undefined;

  let messageCount: number | undefined;
  const rawCount = item.messageCount ?? item.message_count;
  if (typeof rawCount === 'number' && Number.isFinite(rawCount)) {
    messageCount = rawCount;
  }

  return {
    id,
    title,
    preview,
    lastMessageAt,
    createdAt,
    userId,
    messageCount,
  };
}

function pickList(rawResult: any): unknown[] {
  if (!rawResult) return [];
  if (Array.isArray(rawResult)) return rawResult;
  if (Array.isArray(rawResult.items)) return rawResult.items;
  if (Array.isArray(rawResult.conversations)) return rawResult.conversations;
  if (Array.isArray(rawResult.data)) return rawResult.data;
  if (Array.isArray(rawResult.results)) return rawResult.results;
  return [];
}

function pickCursor(rawResult: any, ...keys: string[]): string | undefined {
  if (!rawResult || typeof rawResult !== 'object') return undefined;
  for (const key of keys) {
    const value = rawResult[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[ai-conversations] start: ${new Date(startTime).toISOString()}`);

  const body = await readJsonBody(context);
  const userId = pickString(body, 'user_id', 'userId');
  const limit = clampLimit(body.limit);
  const order = pickOrder(body.order);
  const after = pickString(body, 'after', 'cursor');
  const before = pickString(body, 'before');

  const store = context.agent!.store;

  if (!userId) {
    logger.error('Missing userId');
    logger.log(`[ai-conversations] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'user_id is required' }, 400);
  }

  const params: Record<string, unknown> = {
    userId,
    limit,
    order,
  };
  if (after) params.after = after;
  if (before) params.before = before;

  logger.log('listConversations params:', { userId, limit, order, hasAfter: Boolean(after), hasBefore: Boolean(before) });

  try {
    const result = await store.listConversations(params);

    const items = pickList(result);

    // First pass: normalize what we already have from listConversations.
    // Some runtimes return summaries without a `title`/`firstUserMessage`,
    // so we may need to look up the first user message per-conversation.
    const firstPass = items
      .map((raw): { raw: Record<string, unknown>; normalized: NormalizedConversation | null } => ({
        raw: raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {},
        normalized: normalizeConversation(raw),
      }))
      .filter(entry => entry.normalized !== null) as Array<{ raw: Record<string, unknown>; normalized: NormalizedConversation }>;

    // Identify which conversations still have a fallback "New chat" title and
    // therefore need a getMessages lookup to recover the first user question.
    const needsFirstMessage = firstPass.filter(entry => entry.normalized.title === 'New chat');

    if (needsFirstMessage.length > 0) {
      await Promise.all(needsFirstMessage.map(async entry => {
        try {
          const messages = await store.getMessages({
            conversationId: entry.normalized.id,
            userId,
            limit: 5,
            order: 'asc',
          } as any);
          if (!Array.isArray(messages)) return;
          for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            if ((msg as any).role !== 'user') continue;
            const text = messageContentToText((msg as any).content);
            if (text.trim()) {
              entry.normalized.title = buildTitleFromFirstMessage(text);
              break;
            }
          }
        } catch (e) {
          // Non-fatal — keep the fallback title.
          logger.error(`[ai-conversations] failed to fetch first message for ${entry.normalized.id}:`, e);
        }
      }));
    }

    const normalized = firstPass.map(entry => entry.normalized);

    // Dedupe by id — the user_conversation_index can carry multiple
    // entries for the same conversationId (one per appended user message,
    // since agents/chat writes a user-indexed copy on every turn). The
    // runtime's listConversations does not collapse them, so the sidebar
    // would otherwise render N rows for the same thread. Keep the FIRST
    // occurrence so the runtime's intended ordering (driven by `order=`
    // and pagination cursors) is preserved.
    const seenIds = new Set<string>();
    const conversations: NormalizedConversation[] = [];
    for (const conv of normalized) {
      // dq-* (daily-limit counters) and dt-* (page-action mailboxes) aren't chats
      if (/^(d[qft]|acct)-/.test(conv.id)) continue;
      if (seenIds.has(conv.id)) continue;
      seenIds.add(conv.id);
      conversations.push(conv);
    }
    const duplicatesDropped = normalized.length - conversations.length;

    const nextCursor = pickCursor(result, 'nextCursor', 'next_cursor');
    const previousCursor = pickCursor(result, 'previousCursor', 'previous_cursor', 'prevCursor', 'prev_cursor');

    logger.log(`[ai-conversations] count=${conversations.length}, hasNext=${Boolean(nextCursor)}, lookedUpTitles=${needsFirstMessage.length}, duplicatesDropped=${duplicatesDropped}`);
    logger.log(`[ai-conversations] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);

    return jsonResponse({
      conversations,
      nextCursor,
      previousCursor,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('failed to list conversations:', e);
    logger.log(`[ai-conversations] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({
      status: 'error',
      message,
      conversations: [],
    }, 500);
  }
}
