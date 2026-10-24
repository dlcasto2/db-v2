/**
 * Devon AI feedback — EdgeOne Makers Node Function
 * =================================================
 *
 * cloud-functions/ai-feedback/index.ts maps to **POST /ai-feedback**.
 *
 * Two things this one endpoint does, picked by the body shape:
 *
 * 1. Record a thumbs up/down (the normal case — called from the chat UI,
 *    no auth): { conversation_id, message_id, rating: "up"|"down",
 *    reason?: "wrong_fact"|"misread_page"|"bad_action"|"other", note?,
 *    task_type? } -> { status: "ok" }. Only a rating (plus which reply it's
 *    about) is required; everything else is optional. See agents/_feedback.ts
 *    for exactly what gets stored, and why it's intentionally small.
 *
 * 2. Read the aggregate digest (for the site's maintainer, not visitors):
 *    { action: "digest", admin_key, days?, limit? } -> { summary, entries }.
 *    Refused with 403 unless admin_key matches DEVON_AI_ADMIN_KEY (an
 *    EdgeOne project environment variable) — and refused the same way if
 *    that variable isn't set at all, so there's no "open by default" state.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { createLogger } from '../_logger';
import { listFeedback, recordFeedback, summarizeFeedback } from '../_feedback';

const logger = createLogger('ai-feedback');
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/**
 * A short model label for the feedback log — informational only, so this
 * doesn't need agents/_model.ts's full gateway-resolution logic (which this
 * folder can't import anyway; see _feedback.ts's top comment).
 */
function modelLabel(env: Record<string, string | undefined>): string {
  return env.AI_GATEWAY_MODEL || env.CLAUDE_MODEL || (env.AI_GATEWAY_API_KEY ? '@makers/deepseek-v4-flash' : env.ANTHROPIC_API_KEY ? 'claude-haiku-5-5' : 'unknown');
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await context.request!.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const store = context.agent?.store;
  if (!store) return jsonResponse({ status: 'error', message: 'Feedback needs an agent runtime, which is not available here' }, 500);

  if (body.action === 'digest') {
    const adminKey = context.env.DEVON_AI_ADMIN_KEY;
    const givenKey = typeof body.admin_key === 'string' ? body.admin_key : '';
    if (!adminKey || givenKey !== adminKey) return jsonResponse({ status: 'error', message: 'Not authorized' }, 403);
    const days = typeof body.days === 'number' ? body.days : undefined;
    const limit = typeof body.limit === 'number' ? body.limit : undefined;
    const entries = await listFeedback(store, { days, limit }, logger.error);
    return jsonResponse({ summary: summarizeFeedback(entries), entries });
  }

  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : '';
  const messageId = typeof body.message_id === 'string' ? body.message_id : typeof body.messageId === 'string' ? body.messageId : '';
  if (!conversationId || !messageId) return jsonResponse({ status: 'error', message: 'conversation_id and message_id are required' }, 400);

  const ok = await recordFeedback(
    store,
    {
      conversationId,
      messageId,
      rating: body.rating,
      reason: body.reason,
      note: body.note,
      model: modelLabel(context.env),
      taskType: body.task_type ?? body.taskType,
    },
    logger.error,
  );
  return jsonResponse(ok ? { status: 'ok' } : { status: 'error', message: 'Could not record feedback right now' }, ok ? 200 : 500);
}
