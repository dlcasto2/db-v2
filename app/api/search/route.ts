/**
 * Picks the search engine to send a query to — GET /api/search?q=…
 *
 * Returns { url, engine }: the results page Devon should open. Which engine
 * that is depends on the deployment, because search engines refuse datacenter
 * addresses and they don't all refuse the same ones (see lib/search-engines).
 * The first search on a server instance probes the list in order with a stand
 * in query and remembers the first engine that answers; every search after
 * that is answered from memory.
 *
 * ?engine=<id> forces one, skipping the probe.
 */

import { DEFAULT_ENGINE, PROBE_QUERY, SEARCH_ENGINES, engineById, looksLikeResults, type SearchEngine } from "@/lib/search-engines"

export const runtime = "nodejs"
export const maxDuration = 30

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** How long a probed choice is trusted before Devon looks again */
const REMEMBER_MS = 30 * 60 * 1000
const PROBE_TIMEOUT_MS = 8000

let chosen: { id: string; at: number } | null = null
let probing: Promise<SearchEngine> | null = null

async function answers(engine: SearchEngine): Promise<boolean> {
  try {
    const url = engine.url(PROBE_QUERY)
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return false
    return looksLikeResults(res.url || url, res.status, await res.text())
  } catch {
    return false
  }
}

async function pickEngine(): Promise<SearchEngine> {
  const remembered = chosen && Date.now() - chosen.at < REMEMBER_MS ? engineById(chosen.id) : undefined
  if (remembered) return remembered
  if (probing) return probing

  const run = (async () => {
    for (const engine of SEARCH_ENGINES) {
      if (await answers(engine)) {
        chosen = { id: engine.id, at: Date.now() }
        return engine
      }
    }
    // Every engine refused. Don't remember that — the next search tries again,
    // since this is usually the sort of thing that clears up on its own.
    return DEFAULT_ENGINE
  })()

  probing = run
  try {
    return await run
  } finally {
    probing = null
  }
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const query = (params.get("q") || "").trim()
  const headers = { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" }

  if (!query) {
    return new Response(JSON.stringify({ error: "A q parameter is required" }), { status: 400, headers })
  }

  const engine = engineById(params.get("engine")) ?? (await pickEngine())
  return new Response(JSON.stringify({ url: engine.url(query), engine: engine.id, name: engine.name }), { headers })
}
