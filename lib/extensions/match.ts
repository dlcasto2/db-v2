/** URL matching for Chrome match patterns, Chrome globs and userscript @include rules */

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")

const cache = new Map<string, RegExp | null>()

function cached(key: string, build: () => RegExp | null): RegExp | null {
  if (!cache.has(key)) {
    let re: RegExp | null = null
    try {
      re = build()
    } catch {
      re = null
    }
    cache.set(key, re)
  }
  return cache.get(key)!
}

/** Chrome match pattern: <all_urls>, *://*.example.com/*, https://example.com/path* */
function matchPatternRe(pattern: string): RegExp | null {
  return cached(`m:${pattern}`, () => {
    if (pattern === "<all_urls>") return /^(https?|wss?|ftp|file|data):/i
    const m = /^(\*|https?|wss?|ftp|file|urn):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)?$/i.exec(pattern)
    if (!m) return null
    const [, scheme, host, path = "/"] = m
    const schemeRe = scheme === "*" ? "https?" : escapeRe(scheme)
    let hostRe: string
    if (host === "*") hostRe = "[^/]*"
    else if (host.startsWith("*.")) hostRe = `(?:[^/]*\\.)?${escapeRe(host.slice(2))}`
    else hostRe = escapeRe(host)
    const pathRe = path.split("*").map(escapeRe).join(".*")
    // Ports are ignored by match patterns
    return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`, "i")
  })
}

/** Simple glob over the whole URL: * = anything, ? = one character */
function globRe(glob: string): RegExp | null {
  return cached(`g:${glob}`, () => {
    const body = glob
      .split("")
      .map((c) => (c === "*" ? ".*" : c === "?" ? "." : escapeRe(c)))
      .join("")
    return new RegExp(`^${body}$`, "i")
  })
}

/** Userscript @include / @exclude: a /regex/, or a glob where .tld means any TLD */
function includeRe(rule: string): RegExp | null {
  return cached(`i:${rule}`, () => {
    const regex = /^\/(.+)\/([a-z]*)$/i.exec(rule)
    if (regex) return new RegExp(regex[1], regex[2].includes("i") ? "i" : "")
    if (rule === "*") return /^/
    const body = rule
      .split("")
      .map((c) => (c === "*" ? ".*" : escapeRe(c)))
      .join("")
      .replace(/\\\.tld/g, "\\.[a-z]{2,}(?:\\.[a-z]{2,})?")
    return new RegExp(`^${body}$`, "i")
  })
}

const test = (re: RegExp | null, url: string) => Boolean(re && re.test(url))

export function matchesPattern(pattern: string, url: string): boolean {
  return test(matchPatternRe(pattern), url)
}

export function matchesContentScript(
  rule: { matches: string[]; excludeMatches?: string[]; includeGlobs?: string[]; excludeGlobs?: string[] },
  url: string,
): boolean {
  if (!rule.matches.some((p) => matchesPattern(p, url))) return false
  if (rule.excludeMatches?.some((p) => matchesPattern(p, url))) return false
  if (rule.includeGlobs?.length && !rule.includeGlobs.some((g) => test(globRe(g), url))) return false
  if (rule.excludeGlobs?.some((g) => test(globRe(g), url))) return false
  return true
}

export function matchesUserscript(
  meta: { match: string[]; include: string[]; exclude: string[]; excludeMatch: string[] },
  url: string,
): boolean {
  const hasRules = meta.match.length > 0 || meta.include.length > 0
  const included =
    !hasRules || meta.match.some((p) => matchesPattern(p, url)) || meta.include.some((r) => test(includeRe(r), url))
  if (!included) return false
  if (meta.exclude.some((r) => test(includeRe(r), url))) return false
  if (meta.excludeMatch.some((p) => matchesPattern(p, url))) return false
  return true
}

