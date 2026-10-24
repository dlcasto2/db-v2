/**
 * Redis client for Devon AI's Vercel-native backend (private module).
 *
 * EdgeOne's deployment gets its conversation store for free (`context.store`,
 * from the Makers platform). Vercel has nothing like that, so Devon AI's
 * quota counters, chat history, session state and page-action mailbox all
 * need somewhere durable to live, reachable from any serverless invocation.
 * Upstash Redis fits: it's a plain REST API (no persistent connection to
 * manage from a serverless function) and is what Vercel's own "Upstash for
 * Redis" marketplace integration provisions.
 *
 * Set one of these pairs in Vercel's project environment variables:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash directly, or
 *                                                         Vercel's Upstash integration)
 *   KV_REST_API_URL + KV_REST_API_TOKEN                  (older Vercel KV naming)
 *
 * Without either pair, `redis()` returns null and every caller in
 * store.ts degrades the same way the EdgeOne agents already do when their
 * store hiccups: quota lets messages through, session/mailbox fall back to
 * per-instance memory, history and the conversation list come back empty.
 * Devon AI still answers; it just can't remember between requests.
 */

import { Redis } from "@upstash/redis"

let client: Redis | null | undefined

export function redis(): Redis | null {
  if (client !== undefined) return client
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  client = url && token ? new Redis({ url, token }) : null
  return client
}

export function redisConfigured(): boolean {
  return redis() !== null
}
