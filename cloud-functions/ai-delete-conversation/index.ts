/**
 * Devon AI delete conversation — EdgeOne Makers Node Function
 * ==========================================================
 *
 * File path cloud-functions/ai-delete-conversation/index.ts maps to
 * **POST /ai-delete-conversation**. From TencentEdgeOne/claude-agent-starter-node (MIT).
 *
 * Permanently deletes an entire conversation via
 * `context.agent!.store.deleteConversation({ conversationId })`. Removes the
 * message index, conversation metadata and the global conversation index —
 * irreversible.
 *
 * Requires `user_id` (or `userId`) so we don't accidentally delete a
 * conversation that doesn't belong to the requesting browser.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';

const logger = createLogger('ai-delete-conversation');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

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

function getConversationId(body: Record<string, unknown>): string {
  const value = body.conversation_id ?? body.conversationId;
  return typeof value === 'string' ? value.trim() : '';
}

function getUserId(body: Record<string, unknown>): string {
  const value = body.user_id ?? body.userId;
  return typeof value === 'string' ? value.trim() : '';
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  const startTime = Date.now();
  logger.log(`[ai-delete-conversation] start: ${new Date(startTime).toISOString()}`);

  const body = await readJsonBody(context);
  const conversationId = getConversationId(body);
  const userId = getUserId(body);
  const { store } = context.agent!;

  logger.log('conversationId:', conversationId, 'userId:', userId || '-');

  if (!conversationId || conversationId.startsWith('dq-')) {
    logger.error('Missing conversationId');
    logger.log(`[ai-delete-conversation] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'error', message: 'conversation_id is required' }, 400);
  }

  try {
    const args: Record<string, unknown> = { conversationId };
    if (userId) args.userId = userId;
    await store.deleteConversation(args as any);

    logger.log(`[ai-delete-conversation] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse({ status: 'ok', conversation_id: conversationId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('failed to delete conversation:', e);
    logger.log(`[ai-delete-conversation] end: ${new Date().toISOString()}, total: ${Date.now() - startTime}ms`);
    return jsonResponse(
      { status: 'error', conversation_id: conversationId, message },
      500,
    );
  }
}
