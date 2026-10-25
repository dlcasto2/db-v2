/**
 * Detects a low-level DNS/connect failure reaching googlevideo.com — as
 * opposed to YouTube actually answering and refusing (bot check, a 403, a
 * playability status). Kept free of imports, unlike the rest of
 * lib/youtube-server.ts (which pulls in youtubei.js, and whose YTError class
 * uses TypeScript constructor-parameter-property syntax that Node's native
 * type stripping can't run directly), so this one piece is unit-testable
 * with a plain `node --test` (see youtube-network-error.test.mjs).
 */

/**
 * Marks a reason string as a network failure. Every client hits the
 * identical problem, so trying the rest is pointless, and no cookie or
 * client switch fixes it: the host needs outbound DNS/network access to
 * *.googlevideo.com.
 */
export const UNREACHABLE_PREFIX = "[network] "

/**
 * Node's fetch (undici) throws a `TypeError: fetch failed` for a DNS/connect
 * failure, with the actual reason in `.cause` (e.g. `{code: "ENOTFOUND",
 * hostname: "rr1---sn-abc.googlevideo.com"}`). That's indistinguishable from
 * any other error once reduced to a bare message string, so this has to run
 * on the original thrown value, before it's turned into one.
 */
export function describeIfUnreachable(e: unknown): string | null {
  if (!(e instanceof Error)) return null
  const cause = e.cause as { code?: string; hostname?: string } | undefined
  const dnsOrConnect = cause?.code && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)$/.test(cause.code)
  // A proxied fetch (DEVON_YT_PROXY, via undici's ProxyAgent) can also fail
  // this way with no structured .cause — still a connect failure, just an
  // unlabeled one.
  const unlabeledFetchFailure = !cause && e.message === "fetch failed"
  if (!dnsOrConnect && !unlabeledFetchFailure) return null
  const host = cause?.hostname || "the video server"
  return `${UNREACHABLE_PREFIX}${host}${cause?.code ? ` (${cause.code})` : ""}`
}
