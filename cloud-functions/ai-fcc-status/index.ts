/**
 * Free Claude Code status — EdgeOne Makers Node Function.
 *
 * cloud-functions/ai-fcc-status/index.ts maps to **POST /ai-fcc-status**.
 * Maintainer-only (same DEVON_AI_ADMIN_KEY gate as cloud-functions/ai-feedback):
 * { admin_key } -> { configured, baseUrl, reachable, models?, adminUrl?,
 * error? }. Refused with 403 unless admin_key matches DEVON_AI_ADMIN_KEY (an
 * EdgeOne project environment variable) — refused the same way if that
 * variable isn't set at all, so there's no "open by default" state.
 *
 * Following the official EdgeOne Makers Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request!.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import type { CloudFunctionContext } from '@edgeone/types';
import { checkFccStatus } from '../_fcc_status';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' } as const;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export async function onRequestPost(context: CloudFunctionContext): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await context.request!.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const adminKey = context.env.DEVON_AI_ADMIN_KEY;
  const givenKey = typeof body.admin_key === 'string' ? body.admin_key : '';
  if (!adminKey || givenKey !== adminKey) return jsonResponse({ status: 'error', message: 'Not authorized' }, 403);

  const result = await checkFccStatus(context.env);
  return jsonResponse(result);
}
