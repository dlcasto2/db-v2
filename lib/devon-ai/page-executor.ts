/**
 * Runs Devon AI's page tools against Devon's tabs. The browser component
 * registers a PageHost (tabs, navigation, the live document of the visible
 * tab); this file turns each tool call into actions on it, waits for the page
 * to load or settle, and returns the text the model sees.
 */

import {
  PageActionError,
  captureSnapshot,
  clickRef,
  describe,
  diffSnapshots,
  findRef,
  navigationTarget,
  reveal,
  scrollPage,
  selectRef,
  snapshotDocument,
  topElementObstructing,
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

/**
 * Rough heuristic for "this looks hard to undo" — buying, paying, deleting,
 * sending, canceling. Checked against the element's real accessible name
 * (the button/link text Devon actually found), not the model's own wording,
 * so a model that under-describes a "Delete account" button as "a button"
 * doesn't accidentally get a free pass. Used so the per-site "allow" a
 * visitor gave earlier in the chat doesn't silently cover a later action
 * like this one — those always get a fresh confirmation (see store.ts's
 * askApproval). False negatives are expected (it's a word list); it's a
 * second layer of caution on top of the approval prompt, not a guarantee.
 */
export function looksIrreversible(text: string): boolean {
  return /\b(buy now|purchase|place order|checkout|check out|pay now|make payment|confirm order|confirm payment|subscribe|unsubscribe|delete|remove|cancel|deactivate|close account|donate|transfer funds|send money|submit application|apply now)\b/i.test(
    text,
  )
}

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
      // Prefer the element's real accessible name/role over the model's guess,
      // both for an accurate approval prompt and for deciding whether this
      // looks like something hard to undo (see looksIrreversible below)
      let element = str(args.element) || `element [${ref}]`
      try {
        element = describe(findRef(doc, ref))
      } catch {
        // the ref may not exist yet if the model is acting on stale info; let
        // the real attempt below throw its own, more specific error
      }
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

      // Catch the single biggest cause of a click silently not registering:
      // a modal, cookie banner or other overlay sitting on top of the target.
      // reveal() first, since an off-screen element needs scrolling into view
      // before the hit-test at its center means anything.
      const target = findRef(live, ref)
      reveal(target)
      const obstructedBy = topElementObstructing(live, target)
      if (obstructedBy) {
        throw new PageActionError(
          `Something else is on top of ${describe(target)} right now — looks like ${obstructedBy} (a popup, banner or overlay). ` +
            "Call page_read to see what's covering the page, deal with that first, then try again.",
        )
      }

      // Links to another page and submitted forms are expected to move the tab,
      // either by a full load or in-page (pushState after a fetch, as GitHub does)
      const expectMove = tool === "page_click" ? navigationTarget(live, ref) !== null : tool === "page_type" && Boolean(args.submit)
      const beforeSnap = captureSnapshot(live, status.url)
      const text =
        tool === "page_click"
          ? clickRef(live, ref)
          : tool === "page_type"
            ? typeRef(live, ref, str(args.text), { clear: args.clear !== false, submit: Boolean(args.submit) })
            : selectRef(live, ref, str(args.option))
      const { doc: after, moved } = await settle(host, tabId, live, before, expectMove)

      if (expectMove && moved === "none") {
        // The strongest-confidence failure signal: this was expected to open a
        // page or submit a form, and nothing — no navigation, no in-page
        // update — happened at all.
        return {
          ok: false,
          text:
            `${text}\n\nThis was expected to open a new page or submit, but nothing on the page changed at all — it probably didn't register ` +
            "(an overlay may have intercepted it, or the site needs a real click/keypress). Call page_read to check before trying again.",
          tab: { id: tabId, url: host.status(tabId)?.url ?? status.url, title: host.status(tabId)?.title ?? status.title },
        }
      }

      let verifyNote = ""
      if (after && moved !== "load") {
        const afterSnap = captureSnapshot(after, host.status(tabId)?.url ?? status.url)
        const diff = diffSnapshots(beforeSnap, afterSnap)
        verifyNote = diff.changed
          ? `\n\nWhat changed: ${diff.summary}`
          : "\n\nNothing on the page visibly changed after that — it may not have taken effect. Check for a blocking overlay, a disabled state, or try page_read before assuming it worked."
      }
      return done(host, tabId, text + verifyNote, after)
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

interface SettleResult {
  doc: Document | null
  /** "load" = a new page loaded; "inplace" = the SPA updated without a full load; "none" = nothing moved at all */
  moved: "load" | "inplace" | "none"
}

/**
 * After a click or typing: either a new page loads, the page moves in place
 * (single-page apps fetch and pushState), or the current page just updates.
 * `moved` is how it got there (or didn't) — the strongest signal for whether
 * an action that was expected to navigate or submit actually did anything.
 */
async function settle(
  host: PageHost,
  tabId: string,
  doc: Document,
  beforeLoadId: string | undefined,
  expectMove: boolean,
): Promise<SettleResult> {
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
  if (how === "load") return { doc: await waitForLoad(host, tabId, beforeLoadId), moved: "load" }
  // In-place change or none: wait for the page to stop changing
  await waitForQuiet(doc, how === "inplace" ? 700 : 400, how === "inplace" ? 6000 : 3000)
  if (moved() === "load") return { doc: await waitForLoad(host, tabId, beforeLoadId), moved: "load" }
  return { doc: host.document(tabId) ?? doc, moved: how === "inplace" ? "inplace" : "none" }
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
