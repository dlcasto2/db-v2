/**
 * The search engines Devon can send a query to, and how it tells a real
 * results page from a block page.
 *
 * Search engines refuse requests from datacenter addresses, and which ones
 * refuse depends entirely on where Devon is deployed: DuckDuckGo answers from
 * some hosts and returns its "Unexpected error. Please try again." page from
 * others (Vercel among them), while Bing answers from both. Hard-coding one
 * engine therefore breaks search on some deployments and not others, with no
 * way to tell from the code which.
 *
 * So Devon asks instead: /api/search probes this list in order, once per
 * server instance, and uses the first engine that actually answers. The order
 * below is a preference, not a promise — engines that are lighter and track
 * less come first, and Bing is at the end as the one most likely to answer.
 */

export interface SearchEngine {
  id: string
  name: string
  /** The results page for a query */
  url(query: string): string
}

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: "ddg",
    name: "DuckDuckGo",
    // The no-JavaScript results page: far better through a proxy than the
    // main site, which builds its results in the browser.
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  {
    id: "mojeek",
    name: "Mojeek",
    url: (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: "ecosia",
    name: "Ecosia",
    url: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: "brave",
    name: "Brave Search",
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: "bing",
    name: "Bing",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
]

/** Used when nothing has been probed yet, and if every engine refuses */
export const DEFAULT_ENGINE: SearchEngine = SEARCH_ENGINES[0]

export function engineById(id: string | null | undefined): SearchEngine | undefined {
  return id ? SEARCH_ENGINES.find((e) => e.id === id) : undefined
}

/** A query to probe with, so a cold start doesn't send the real one to engines that refuse it */
export const PROBE_QUERY = "weather"

/** Everything up to the registrable-looking part, e.g. news.bbc.co.uk -> co.uk — close enough to group a site's own hosts */
function siteOf(host: string): string {
  return host.toLowerCase().split(".").slice(-2).join(".")
}

/**
 * Whether a fetched page is a real results page rather than a block, CAPTCHA,
 * challenge or error page.
 *
 * This counts the distinct other sites the page links to, rather than looking
 * for engine-specific markup, because every engine words its block page
 * differently and rewrites its results markup often — but the difference
 * between the two is stark and stays stark: a results page links out to
 * dozens of sites, and a block page links out to none. Matching on the
 * wording would also misfire on a search FOR those words ("captcha").
 */
export function looksLikeResults(pageUrl: string, status: number, html: string): boolean {
  if (status !== 200 || html.length < 2000) return false

  let ownSite = ""
  try {
    ownSite = siteOf(new URL(pageUrl).hostname)
  } catch {
    return false
  }

  const sites = new Set<string>()
  for (const match of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"'\s>]+)/gi)) {
    let host: string
    try {
      host = new URL(match[1]).hostname
    } catch {
      continue
    }
    const site = siteOf(host)
    // The engine's own links (nav, settings, its CDN) say nothing about results
    if (!site || site === ownSite) continue
    sites.add(site)
    if (sites.size >= RESULT_SITES) return true
  }
  return false
}

/** How many distinct other sites a page must link to before it counts as results */
const RESULT_SITES = 6
