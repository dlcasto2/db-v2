/**
 * Runs Devon AI's page tools against Devon's tabs. The browser component
 * registers a PageHost (tabs, navigation, the live document of the visible
 * tab); this file turns each tool call into actions on it, waits for the page
 * to load or settle, and returns the text the model sees.
 */

import {
  PageActionError,
  clickRef,
  navigationTarget,
  scrollPage,
  selectRef,
  snapshotDocument,
  typeRef,
  waitForQuiet,
} from "@/lib/devon-ai/page-actions"

export interface TabInfo {
  id: string
  title: string
  url: string
  active: boolean
  /** web = a site through the proxy; devon = one of Devon's own pages; new = empty new tab */
  kind: "web" | "devon" | "new"
}

export interface TabStatus {
  url: string
  title: string
  loading: boolean
  /** Changes every time a page finishes loading */
  loadId?: string
  error?: string
  /** The tab holds a web page (as opposed to a file such as an image or PDF) */
  page?: boolean
}

export interface PageHost {
  tabs(): TabInfo[]
  /** The tab page tools use when none is named: the visible tab if it's a site, else the last site tab */
  defaultTarget(): string | null
  select(tabId: string): void
  /** Opens a new tab, returns its id */
  open(url: string): string
  /** An address, or back / forward / reload */
  navigate(tabId: string, to: string): void
  status(tabId: string): TabStatus | null
  /** The live document of a tab, only while it's visible and loaded through Devon */
  document(tabId: string): Document | null
  /** Show the Devon AI panel next to the page so the visitor can watch */
  revealPanel(): void
}

export interface PageActionRequest {
  callId: string
  tool: string
  args: Record<string, unknown>
}

export interface PageActionOutcome {
  ok: boolean
  text: string
  tab?: { id: string; url: string; title: string }
}

export interface ExecutorHooks {
  /** Ask the visitor before changing a page; resolves false if they decline */
  approve(site: string, description: string): Promise<boolean>
  /** True once the visitor pressed Stop */
  stopped(): boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

/** "example.com/x" → "https://example.com/x"; refuses anything that isn't http(s) */
function normalizeUrl(input: string): string {
  const s = input.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    throw new PageActionError(`"${input}" isn't a valid address.`)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new PageActionError("Devon AI can only open http and https addresses.")
  return u.href
}

const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

export async function runPageAction(host: PageHost, req: PageActionRequest, hooks: ExecutorHooks): Promise<PageActionOutcome> {
  const { tool, args } = req
  let tabId: string | null = null
  try {
    if (hooks.stopped()) throw new PageActionError("Stopped by the user.")

    if (tool === "tabs_list") return { ok: true, text: listTabs(host) }

    if (tool === "tab_open") {
      const url = normalizeUrl(str(args.url))
      tabId = host.open(url)
      host.revealPanel()
      const doc = await waitForLoad(host, tabId, undefined)
      return done(host, tabId, `Opened ${url} in a new tab [${tabId}].`, doc)
    }

    if (tool === "tab_select") {
      tabId = str(args.tab_id)
      const tab = host.tabs().find((t) => t.id === tabId)
      if (!tab) throw new PageActionError(`No tab [${tabId}]. Call tabs_list to see the open tabs.`)
      host.select(tabId)
      host.revealPanel()
      if (tab.kind !== "web") return { ok: true, text: `Switched to tab [${tabId}] (${tab.title || "new tab"}). It has no website open.` }
      const doc = await ensureDocument(host, tabId)
      return done(host, tabId, `Switched to tab [${tabId}].`, doc)
    }

    tabId = resolveTarget(host, str(args.tab_id) || null)

    if (tool === "page_navigate") {
      const to = str(args.to).trim()
      const before = host.status(tabId)?.loadId
      if (["back", "forward", "reload"].includes(to.toLowerCase())) {
        host.select(tabId)
        host.navigate(tabId, to.toLowerCase())
      } else {
        host.select(tabId)
        host.navigate(tabId, normalizeUrl(to))
      }
      host.revealPanel()
      const doc = await waitForLoad(host, tabId, before)
      return done(host, tabId, to.match(/^(back|forward|reload)$/i) ? `Went ${to.toLowerCase()}.` : `Opened ${to}.`, doc)
    }

    const doc = await ensureDocument(host, tabId)
    const status = host.status(tabId)!

    if (tool === "page_read") {
      return {
        ok: true,
        text: snapshotDocument(doc, { url: status.url, title: status.title || doc.title, query: str(args.query) || undefined, offset: num(args.offset) }),
        tab: { id: tabId, url: status.url, title: status.title || doc.title },
      }
    }

    if (tool === "page_scroll") {
      const text = scrollPage(doc, { direction: str(args.direction) || undefined, ref: num(args.ref) })
      await waitForQuiet(doc, 250, 1500)
      return done(host, tabId, text, doc)
    }

    if (tool === "page_click" || tool === "page_type" || tool === "page_select") {
      const ref = num(args.ref)
      if (!ref) throw new PageActionError("A ref from page_read is needed.")
      const element = str(args.element) || `element [${ref}]`
      const description =
        tool === "page_click"
          ? `click ${element}`
          : tool === "page_type"
            ? `type "${truncate(str(args.text), 50)}" into ${element}${args.submit ? " and press Enter" : ""}`
            : `choose "${truncate(str(args.option), 40)}" in ${element}`
      const site = siteOf(status.url)
      if (!(await hooks.approve(site, description))) {
        return {
          ok: false,
          text: `The user declined: ${description} on ${site}. Don't try again; ask them what they'd like to do.`,
          tab: { id: tabId, url: status.url, title: status.title },
        }
      }
      if (hooks.stopped()) throw new PageActionError("Stopped by the user.")
      // The page may have changed while the visitor decided
      const live = await ensureDocument(host, tabId)
      const before = host.status(tabId)?.loadId
      // Links to another page and submitted forms are expected to move the tab,
      // either by a full load or in-page (pushState after a fetch, as GitHub does)
      const expectMove = tool === "page_click" ? navigationTarget(live, ref) !== null : tool === "page_type" && Boolean(args.submit)
      const text =
        tool === "page_click"
          ? clickRef(live, ref)
          : tool === "page_type"
            ? typeRef(live, ref, str(args.text), { clear: args.clear !== false, submit: Boolean(args.submit) })
            : selectRef(live, ref, str(args.option))
      const after = await settle(host, tabId, live, before, expectMove)
      return done(host, tabId, text, after)
    }

    throw new PageActionError(`Unknown page tool "${tool}".`)
  } catch (e) {
    const message = e instanceof PageActionError ? e.message : `Devon couldn't do that: ${e instanceof Error ? e.message : String(e)}`
    const st = tabId ? host.status(tabId) : null
    return { ok: false, text: message, ...(tabId && st ? { tab: { id: tabId, url: st.url, title: st.title } } : {}) }
  }
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function listTabs(host: PageHost): string {
  const target = host.defaultTarget()
  const tabs = host.tabs()
  if (!tabs.length) return "No tabs are open."
  return [
    "Open tabs (★ = page tools act here by default):",
    ...tabs.map(
      (t) =>
        `[${t.id}]${t.id === target ? " ★" : ""}${t.active ? " (visible)" : ""} ${t.title || (t.kind === "new" ? "New tab" : "Untitled")} — ${t.url || "no page"}${t.kind === "devon" ? " (Devon's own page; page tools can't read it)" : ""}`,
    ),
  ].join("\n")
}

function resolveTarget(host: PageHost, requested: string | null): string {
  const tabs = host.tabs()
  if (requested) {
    const tab = tabs.find((t) => t.id === requested)
    if (!tab) throw new PageActionError(`No tab [${requested}]. Call tabs_list to see the open tabs.`)
    if (tab.kind === "devon") throw new PageActionError(`Tab [${requested}] is one of Devon's own pages (${tab.url}), not a website.`)
    if (tab.kind === "new") throw new PageActionError(`Tab [${requested}] is empty. Use page_navigate with tab_id to open a page in it.`)
    return requested
  }
  const target = host.defaultTarget()
  if (!target) throw new PageActionError("No website is open in Devon. Use tab_open to open one, or ask the user which page to use.")
  return target
}

/** Make the tab visible if needed and wait for its page */
async function ensureDocument(host: PageHost, tabId: string): Promise<Document> {
  let doc = host.document(tabId)
  if (doc && !host.status(tabId)?.loading) return doc
  host.select(tabId)
  host.revealPanel()
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const st = host.status(tabId)
    if (!st) throw new PageActionError("That tab was closed.")
    if (st.error && !st.loading) throw new PageActionError(`The page couldn't load: ${st.error}`)
    doc = host.document(tabId)
    if (doc && !st.loading && doc.readyState !== "loading") {
      await sleep(150)
      return host.document(tabId) ?? doc
    }
    await sleep(120)
  }
  throw new PageActionError("The page is taking too long to load.")
}

/** After navigation started: wait for the new page to finish loading */
async function waitForLoad(host: PageHost, tabId: string, beforeLoadId: string | undefined): Promise<Document | null> {
  // Give the navigation a moment to register
  const startBy = Date.now() + 2500
  while (Date.now() < startBy) {
    const st = host.status(tabId)
    if (!st) throw new PageActionError("That tab was closed.")
    if (st.loading || st.loadId !== beforeLoadId || st.error) break
    await sleep(80)
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const st = host.status(tabId)
    if (!st) throw new PageActionError("That tab was closed.")
    if (!st.loading) {
      if (st.error) return null
      // A file (image, PDF) has no document for us
      if (!st.page && st.loadId !== beforeLoadId) return null
      // A web page: Devon writes it into a fresh frame a moment after loading
      const doc = host.document(tabId)
      if (doc && doc.readyState !== "loading") {
        await waitForQuiet(doc, 300, 2500)
        return host.document(tabId) ?? doc
      }
    }
    await sleep(120)
  }
  throw new PageActionError("The page is taking too long to load.")
}

/** Where the page is: the tab's address plus the frame's own path (which follows pushState) */
function placeOf(host: PageHost, tabId: string, doc: Document): string {
  let path = ""
  try {
    path = doc.location.pathname + doc.location.search
  } catch {
    path = ""
  }
  return `${host.status(tabId)?.url ?? ""} ${path}`
}

/**
 * After a click or typing: either a new page loads, the page moves in place
 * (single-page apps fetch and pushState), or the current page just updates.
 */
async function settle(
  host: PageHost,
  tabId: string,
  doc: Document,
  beforeLoadId: string | undefined,
  expectMove: boolean,
): Promise<Document | null> {
  const startPlace = placeOf(host, tabId, doc)
  const moved = () => {
    const st = host.status(tabId)
    if (!st) return "gone" as const
    if (st.loading || st.loadId !== beforeLoadId) return "load" as const
    if (placeOf(host, tabId, doc) !== startPlace) return "inplace" as const
    return null
  }
  // A link or a submitted form gets up to 12 s to start moving; anything else a short look
  const deadline = Date.now() + (expectMove ? 12_000 : 600)
  let how = moved()
  while (!how && Date.now() < deadline) {
    await sleep(120)
    how = moved()
  }
  if (how === "gone") throw new PageActionError("That tab was closed.")
  if (how === "load") return waitForLoad(host, tabId, beforeLoadId)
  // In-place change or none: wait for the page to stop changing
  await waitForQuiet(doc, how === "inplace" ? 700 : 400, how === "inplace" ? 6000 : 3000)
  if (moved() === "load") return waitForLoad(host, tabId, beforeLoadId)
  return host.document(tabId) ?? doc
}

/** The action's result plus a short look at the page afterwards */
function done(host: PageHost, tabId: string, what: string, doc: Document | null): PageActionOutcome {
  const st = host.status(tabId)
  const tab = st ? { id: tabId, url: st.url, title: st.title } : undefined
  if (st?.error) return { ok: true, text: `${what}\nThe page then failed to load: ${st.error}`, tab }
  if (!doc) return { ok: true, text: `${what}\nNow showing ${st?.url || "a page"} (not a web page Devon AI can read).`, tab }
  const snapshot = snapshotDocument(doc, { url: st?.url || doc.URL, title: st?.title || doc.title, maxElements: 60, maxText: 1500 })
  return { ok: true, text: `${what}\n\nThe page now (call page_read for all of it):\n${snapshot}`, tab }
}
