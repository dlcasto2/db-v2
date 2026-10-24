/**
 * What Devon AI does inside a page: read it as text with numbered elements,
 * click, type, choose options and scroll. Plain DOM code, run against the
 * proxied page's document (same origin as Devon), so it can be tested on any
 * page. Elements get a stable `data-devon-ref` number the model refers to.
 */

export class PageActionError extends Error {}

const REF_ATTR = "data-devon-ref"
const FOCUS_ATTR = "data-devon-ai-focus"

const CANDIDATES = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "textarea",
  "select",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=option]",
  "[role=combobox]",
  "[role=textbox]",
  "[role=searchbox]",
  "[onclick]",
].join(",")

type Win = Window & typeof globalThis & { __devonRefCounter?: number }

function winOf(doc: Document): Win {
  return doc.defaultView as Win
}

function squash(s: string | null | undefined, max = 80): string {
  const t = (s || "").replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function isVisible(el: Element): boolean {
  const win = winOf(el.ownerDocument)
  if (!(el instanceof win.HTMLElement)) return false
  if (el.closest("[aria-hidden=true],[inert]")) return false
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) {
    // Custom checkboxes/radios often hide the real input behind a label
    if (!(el instanceof win.HTMLInputElement && ["checkbox", "radio"].includes(el.type) && el.labels?.length)) return false
  }
  // Catches menus hidden with opacity or on a hidden ancestor (newer browsers)
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility
  if (check && !check.call(el, { opacityProperty: true, visibilityProperty: true })) {
    if (!(el instanceof win.HTMLInputElement && ["checkbox", "radio"].includes(el.type) && el.labels?.length)) return false
  }
  const style = win.getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none"
}

/** Real address of a link (Devon may have rewritten it through /api/proxy) */
function linkTarget(a: HTMLAnchorElement): string {
  const href = a.href || a.getAttribute("href") || ""
  try {
    const u = new URL(href, a.ownerDocument.baseURI)
    if (u.pathname === "/api/proxy" && u.searchParams.get("url")) return u.searchParams.get("url")!
    return u.href
  } catch {
    return href
  }
}

function textOfIds(doc: Document, ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => doc.getElementById(id)?.textContent || "")
    .join(" ")
}

function isSensitiveField(el: Element): boolean {
  const win = winOf(el.ownerDocument)
  if (!(el instanceof win.HTMLInputElement)) return false
  if (el.type === "password") return true
  const hints = `${el.autocomplete} ${el.name} ${el.id}`.toLowerCase()
  return /\bcc-|card.?num|cardnumber|\bcvc\b|\bcvv\b|security.?code|one-time-code|\botp\b/.test(hints)
}

function roleOf(el: HTMLElement): string {
  const win = winOf(el.ownerDocument)
  const role = el.getAttribute("role")
  if (role) return role
  if (el instanceof win.HTMLAnchorElement) return "link"
  if (el instanceof win.HTMLButtonElement || el.tagName === "SUMMARY") return "button"
  if (el instanceof win.HTMLSelectElement) return "dropdown"
  if (el instanceof win.HTMLTextAreaElement) return "textbox"
  if (el instanceof win.HTMLInputElement) {
    const t = el.type
    if (["button", "submit", "reset", "image"].includes(t)) return "button"
    if (t === "checkbox" || t === "radio") return t
    if (t === "search") return "searchbox"
    if (t === "range") return "slider"
    if (t === "file") return "file input"
    if (t === "password") return "password field"
    return "textbox"
  }
  if (el.isContentEditable) return "textbox"
  return "clickable"
}

function nameOf(el: HTMLElement): string {
  const doc = el.ownerDocument
  const win = winOf(doc)
  const aria = el.getAttribute("aria-label")
  if (aria) return squash(aria)
  const labelledby = el.getAttribute("aria-labelledby")
  if (labelledby) {
    const t = squash(textOfIds(doc, labelledby))
    if (t) return t
  }
  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement || el instanceof win.HTMLSelectElement) {
    const label = Array.from(el.labels ?? [])
      .map((l) => l.textContent)
      .join(" ")
    if (squash(label)) return squash(label)
    if (el instanceof win.HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return squash(el.value)
    const ph = el.getAttribute("placeholder")
    if (ph) return squash(ph)
  }
  const text = squash((el as HTMLElement).innerText || el.textContent)
  if (text) return text
  const img = el.querySelector("img[alt]")
  if (img?.getAttribute("alt")) return squash(img.getAttribute("alt"))
  return squash(el.getAttribute("title") || el.getAttribute("name") || "")
}

function detailsOf(el: HTMLElement): string {
  const win = winOf(el.ownerDocument)
  const parts: string[] = []
  if (el instanceof win.HTMLAnchorElement) parts.push(`→ ${squash(linkTarget(el), 120)}`)
  if (el instanceof win.HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") parts.push(el.checked ? "checked" : "not checked")
    else if (el.type === "password") parts.push(el.value ? "filled" : "empty")
    else if (!["button", "submit", "reset", "image", "file"].includes(el.type)) parts.push(`value="${squash(el.value, 60)}"`)
  }
  if (el instanceof win.HTMLTextAreaElement) parts.push(`value="${squash(el.value, 60)}"`)
  if (el instanceof win.HTMLSelectElement) {
    const opts = Array.from(el.options)
    parts.push(`selected="${squash(el.selectedOptions[0]?.text, 40)}"`)
    parts.push(`options: ${opts.slice(0, 12).map((o) => squash(o.text, 30)).join(" | ")}${opts.length > 12 ? ` | …${opts.length - 12} more` : ""}`)
  }
  const expanded = el.getAttribute("aria-expanded")
  if (expanded) parts.push(expanded === "true" ? "expanded" : "collapsed")
  if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) parts.push("current")
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled")
  if ((el as HTMLInputElement).required) parts.push("required")
  if (isSensitiveField(el)) parts.push("Devon AI can't type here")
  return parts.join(", ")
}

interface Listed {
  ref: number
  line: string
  inView: boolean
  top: number
}

/** Visible interactive elements, numbered (numbers stick to an element for the life of the page) */
function listElements(doc: Document): Listed[] {
  const win = winOf(doc)
  const seen = new Set<Element>()
  const out: Listed[] = []
  const vh = win.innerHeight
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(CANDIDATES))) {
    if (seen.has(el) || !isVisible(el)) continue
    // A button inside a link (or the reverse) is one thing to click
    const outer = el.parentElement?.closest(CANDIDATES)
    if (outer && seen.has(outer) && !(el instanceof win.HTMLInputElement) && !(el instanceof win.HTMLSelectElement)) continue
    seen.add(el)
    let ref = Number(el.getAttribute(REF_ATTR))
    if (!ref) {
      ref = win.__devonRefCounter = (win.__devonRefCounter ?? 0) + 1
      el.setAttribute(REF_ATTR, String(ref))
    }
    const name = nameOf(el)
    const details = detailsOf(el)
    const rect = el.getBoundingClientRect()
    out.push({
      ref,
      line: `[${ref}] ${roleOf(el)}${name ? ` "${name}"` : ""}${details ? ` — ${details}` : ""}`,
      inView: rect.bottom > 0 && rect.top < vh,
      top: rect.top,
    })
  }
  return out
}

function pageText(doc: Document): string {
  const body = doc.body
  if (!body) return ""
  return (body.innerText || body.textContent || "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function scrollInfo(doc: Document): string {
  const win = winOf(doc)
  const el = doc.scrollingElement || doc.documentElement
  const max = Math.max(1, el.scrollHeight - win.innerHeight)
  const pct = el.scrollHeight <= win.innerHeight ? 100 : Math.round((el.scrollTop / max) * 100)
  return `${pct}% down (page ${el.scrollHeight}px tall, window ${win.innerHeight}px)`
}

export interface SnapshotOptions {
  url: string
  title?: string
  query?: string
  offset?: number
  maxElements?: number
  maxText?: number
}

/** The page as the model sees it: address, scroll position, numbered elements and text */
export function snapshotDocument(doc: Document, opts: SnapshotOptions): string {
  const maxElements = opts.maxElements ?? 150
  const maxText = opts.maxText ?? 6000
  const query = opts.query?.trim().toLowerCase()
  const lines = [`Page: ${squash(opts.title ?? doc.title, 200) || "(no title)"}`, `URL: ${opts.url}`, `Scroll: ${scrollInfo(doc)}`]

  let elements = listElements(doc)
  if (query) elements = elements.filter((e) => e.line.toLowerCase().includes(query))
  let shown = elements
  if (elements.length > maxElements) {
    // Keep what's on screen and nearest to it, then put them back in page order
    shown = [...elements]
      .sort((a, b) => Number(b.inView) - Number(a.inView) || Math.abs(a.top) - Math.abs(b.top))
      .slice(0, maxElements)
      .sort((a, b) => a.ref - b.ref)
  }
  lines.push("", query ? `Elements matching "${opts.query}":` : "Elements ([ref] role \"name\" — details; * = on screen now):")
  if (!shown.length) lines.push(query ? "(none)" : "(no interactive elements)")
  for (const e of shown) lines.push(`${e.line}${e.inView && !query ? " *" : ""}`)
  if (elements.length > shown.length) lines.push(`(${elements.length - shown.length} more off screen — scroll, or read with a query)`)

  const text = pageText(doc)
  if (query) {
    const all = text.split("\n")
    const hits: string[] = []
    all.forEach((line, i) => {
      if (line.toLowerCase().includes(query)) hits.push(...all.slice(Math.max(0, i - 1), i + 2).map((l) => squash(l, 300)), "…")
    })
    lines.push("", `Text lines containing "${opts.query}":`, hits.length ? hits.slice(0, 120).join("\n") : "(none)")
  } else {
    const start = Math.min(opts.offset ?? 0, text.length)
    const chunk = text.slice(start, start + maxText)
    const end = start + chunk.length
    lines.push(
      "",
      `Text (characters ${start.toLocaleString("en-US")}–${end.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")}${end < text.length ? `; read on with offset=${end}` : ""}):`,
      chunk || "(no text)",
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Acting on elements
// ---------------------------------------------------------------------------

export function findRef(doc: Document, ref: number): HTMLElement {
  const el = doc.querySelector<HTMLElement>(`[${REF_ATTR}="${ref}"]`)
  if (!el || !el.isConnected) {
    throw new PageActionError(`There's no element [${ref}] on the page any more — it may have changed. Call page_read again.`)
  }
  return el
}

/**
 * Something else is on top of `el` at the point Devon AI would click/type —
 * almost always a modal, cookie banner or other overlay that would silently
 * swallow the action. Call after reveal() so off-screen elements are already
 * scrolled into view. Returns a short description of what's covering it, or
 * null when `el` (or an ancestor/descendant of it — e.g. a <label> wrapping a
 * hidden checkbox) is really the topmost thing there.
 */
export function topElementObstructing(doc: Document, el: HTMLElement): string | null {
  const win = winOf(doc)
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null // e.g. a custom checkbox hidden behind its label
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), win.innerWidth - 1)
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), win.innerHeight - 1)
  if (rect.bottom < 0 || rect.top > win.innerHeight) return null // still off screen; let the caller decide
  const top = doc.elementFromPoint(x, y)
  if (!top || top === el || el.contains(top) || top.contains(el)) return null
  if (el instanceof win.HTMLInputElement && el.labels?.length && Array.from(el.labels).some((l) => l === top || l.contains(top))) return null
  return squash(nameOf(top as HTMLElement) || top.tagName.toLowerCase(), 60)
}

/** Briefly outline the element so the visitor sees what Devon AI is touching */
export function highlight(el: HTMLElement) {
  const doc = el.ownerDocument
  if (!doc.getElementById("devon-ai-focus-style")) {
    const style = doc.createElement("style")
    style.id = "devon-ai-focus-style"
    style.textContent = `[${FOCUS_ATTR}]{outline:3px solid #8b8cf8!important;outline-offset:2px!important;box-shadow:0 0 0 6px rgba(139,140,248,.28)!important;border-radius:4px}`
    ;(doc.head || doc.documentElement).appendChild(style)
  }
  el.setAttribute(FOCUS_ATTR, "")
  winOf(doc).setTimeout(() => el.removeAttribute(FOCUS_ATTR), 1600)
}

export function reveal(el: HTMLElement) {
  try {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior })
  } catch {
    el.scrollIntoView()
  }
  highlight(el)
}

export function describe(el: HTMLElement): string {
  const name = nameOf(el)
  return `${roleOf(el)}${name ? ` "${name}"` : ""}`
}

function isDisabled(el: HTMLElement): boolean {
  return Boolean((el as HTMLButtonElement).disabled) || el.getAttribute("aria-disabled") === "true"
}

function pointerEvents(el: HTMLElement) {
  const win = winOf(el.ownerDocument)
  const rect = el.getBoundingClientRect()
  const init = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  }
  const PointerEv = win.PointerEvent ?? win.MouseEvent
  el.dispatchEvent(new PointerEv("pointerdown", { ...init, pointerType: "mouse", isPrimary: true } as PointerEventInit))
  el.dispatchEvent(new win.MouseEvent("mousedown", init))
  el.focus?.({ preventScroll: true })
  el.dispatchEvent(new PointerEv("pointerup", { ...init, pointerType: "mouse", isPrimary: true } as PointerEventInit))
  el.dispatchEvent(new win.MouseEvent("mouseup", init))
}

/**
 * Where clicking this element should take the page, when it's a link to a
 * different page in the same tab (not just another #section, not a new window)
 */
export function navigationTarget(doc: Document, ref: number): string | null {
  const win = winOf(doc)
  const el = doc.querySelector<HTMLElement>(`[${REF_ATTR}="${ref}"]`)
  const a = el?.closest("a[href]")
  if (!a || !(a instanceof win.HTMLAnchorElement)) return null
  if (a.target && a.target !== "_self" && a.target !== "_top" && a.target !== "_parent") return null
  const target = linkTarget(a)
  if (!/^https?:/i.test(target)) return null
  const strip = (u: string) => u.split("#")[0]
  return strip(target) === strip(doc.baseURI) || strip(target) === strip(win.location.href) ? null : target
}

export function clickRef(doc: Document, ref: number): string {
  const el = findRef(doc, ref)
  const win = winOf(doc)
  if (el instanceof win.HTMLInputElement && el.type === "file") {
    throw new PageActionError("Devon AI can't choose files to upload. Ask the user to pick the file.")
  }
  if (isDisabled(el)) throw new PageActionError(`${describe(el)} is disabled.`)
  reveal(el)
  pointerEvents(el)
  el.click()
  return `Clicked ${describe(el)}.`
}

/** Set a field's value the way a user would, so React/Vue-style pages notice */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const win = winOf(el.ownerDocument)
  const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  if (setter) setter.call(el, value)
  else el.value = value
}

function key(el: HTMLElement, type: string, k: string) {
  const win = winOf(el.ownerDocument)
  const code = k === "Enter" ? 13 : 0
  return el.dispatchEvent(
    new win.KeyboardEvent(type, { key: k, code: k, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit),
  )
}

export function typeRef(doc: Document, ref: number, text: string, opts: { clear?: boolean; submit?: boolean } = {}): string {
  const el = findRef(doc, ref)
  const win = winOf(doc)
  const clear = opts.clear !== false
  if (isSensitiveField(el)) {
    throw new PageActionError("That's a password, verification-code or payment field. Devon AI doesn't type there — ask the user to fill it in.")
  }
  if (isDisabled(el) || (el as HTMLInputElement).readOnly) throw new PageActionError(`${describe(el)} can't be edited.`)
  reveal(el)
  el.focus({ preventScroll: true })

  if (el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement) {
    if (el instanceof win.HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(el.type)) {
      throw new PageActionError(`${describe(el)} isn't a text field. Use page_click for it.`)
    }
    const next = clear ? text : el.value + text
    setNativeValue(el, next)
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
    el.dispatchEvent(new win.Event("change", { bubbles: true }))
  } else if (el.isContentEditable || ["textbox", "searchbox", "combobox"].includes(el.getAttribute("role") || "")) {
    const editable = el.isContentEditable ? el : el.querySelector<HTMLElement>("[contenteditable=''],[contenteditable='true'],input,textarea")
    if (!editable) throw new PageActionError(`${describe(el)} isn't editable.`)
    if (editable !== el) return typeRef(doc, Number(listAndRef(editable)), text, opts)
    if (clear) {
      const range = doc.createRange()
      range.selectNodeContents(el)
      const sel = win.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
    // execCommand keeps the page's own editor state in sync; fall back to plain text
    const ok = doc.execCommand?.("insertText", false, text)
    if (!ok) {
      el.textContent = clear ? text : (el.textContent || "") + text
      el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
    }
  } else {
    throw new PageActionError(`${describe(el)} isn't a text field.`)
  }

  let submitted = ""
  if (opts.submit) {
    const proceed = key(el, "keydown", "Enter")
    key(el, "keypress", "Enter")
    key(el, "keyup", "Enter")
    const form = (el as HTMLInputElement).form
    if (proceed && form) {
      try {
        form.requestSubmit()
      } catch {
        form.submit()
      }
      submitted = " and submitted the form"
    } else {
      submitted = " and pressed Enter"
    }
  }
  const shown = text.length > 60 ? `${text.slice(0, 57)}…` : text
  return `Typed "${shown}" into ${describe(el)}${submitted}.`
}

/** Give an element a ref (for an editable found inside a wrapper) */
function listAndRef(el: HTMLElement): string {
  const win = winOf(el.ownerDocument)
  let ref = el.getAttribute(REF_ATTR)
  if (!ref) {
    ref = String((win.__devonRefCounter = (win.__devonRefCounter ?? 0) + 1))
    el.setAttribute(REF_ATTR, ref)
  }
  return ref
}

export function selectRef(doc: Document, ref: number, option: string): string {
  const el = findRef(doc, ref)
  const win = winOf(doc)
  if (!(el instanceof win.HTMLSelectElement)) {
    throw new PageActionError(`${describe(el)} isn't a dropdown list. For custom menus, click it, read the page, then click the option.`)
  }
  if (el.disabled) throw new PageActionError(`${describe(el)} is disabled.`)
  const want = option.trim().toLowerCase()
  const opts = Array.from(el.options)
  const match =
    opts.find((o) => o.text.trim().toLowerCase() === want) ??
    opts.find((o) => o.value.toLowerCase() === want) ??
    opts.find((o) => o.text.trim().toLowerCase().includes(want))
  if (!match) {
    throw new PageActionError(`No option "${option}" in ${describe(el)}. Options: ${opts.map((o) => squash(o.text, 30)).join(" | ")}`)
  }
  reveal(el)
  el.focus({ preventScroll: true })
  el.value = match.value
  match.selected = true
  el.dispatchEvent(new win.Event("input", { bubbles: true }))
  el.dispatchEvent(new win.Event("change", { bubbles: true }))
  return `Chose "${squash(match.text, 60)}" in ${describe(el)}.`
}

export function scrollPage(doc: Document, opts: { direction?: string; ref?: number }): string {
  const win = winOf(doc)
  if (opts.ref) {
    const el = findRef(doc, opts.ref)
    reveal(el)
    return `Scrolled to ${describe(el)}. Now ${scrollInfo(doc)}.`
  }
  const el = doc.scrollingElement || doc.documentElement
  const step = Math.round(win.innerHeight * 0.85)
  switch (opts.direction) {
    case "up":
      win.scrollBy({ top: -step, behavior: "instant" as ScrollBehavior })
      break
    case "top":
      win.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior })
      break
    case "bottom":
      win.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior })
      break
    default:
      win.scrollBy({ top: step, behavior: "instant" as ScrollBehavior })
  }
  return `Scrolled ${opts.direction || "down"}. Now ${scrollInfo(doc)}.`
}

// ---------------------------------------------------------------------------
// Verifying an action actually did something (not just that it was dispatched)
// ---------------------------------------------------------------------------

export interface StructuredSnapshot {
  url: string
  elements: { ref: number; line: string }[]
  text: string
}

/** A lightweight, comparable snapshot of a page's state — for diffing, not for showing to the model directly */
export function captureSnapshot(doc: Document, url: string): StructuredSnapshot {
  return { url, elements: listElements(doc).map((e) => ({ ref: e.ref, line: e.line })), text: pageText(doc) }
}

function normText(t: string): string {
  return t.replace(/\s+/g, " ").trim()
}

/** Lines that look like a price or availability changing (the case a plain text diff is most useful for) */
const PRICE_LIKE = /[$£€¥]\s?\d|\d\s?%|\bin stock\b|\bout of stock\b|\bsold out\b|\bunavailable\b|\bavailable\b|\bprice\b/i

function priceLikeChanges(beforeText: string, afterText: string, max = 5): string[] {
  const before = new Set(beforeText.split("\n").map(normText).filter(Boolean))
  const out: string[] = []
  for (const raw of afterText.split("\n")) {
    const line = normText(raw)
    if (!line || before.has(line) || !PRICE_LIKE.test(line)) continue
    out.push(squash(line, 90))
    if (out.length >= max) break
  }
  return out
}

export interface SnapshotDiff {
  /** Anything at all changed (url, an element, or the page text) */
  changed: boolean
  /** One short line for the model: what changed, or that nothing did */
  summary: string
}

/**
 * What changed between two snapshots of the same tab. Element lines already
 * carry state (checked/selected/value/disabled/…), so a ref whose line didn't
 * change really didn't change — this is what lets an action's result say
 * "nothing happened" instead of just dumping a second full page read and
 * hoping the model notices.
 */
export function diffSnapshots(before: StructuredSnapshot, after: StructuredSnapshot): SnapshotDiff {
  const beforeByRef = new Map(before.elements.map((e) => [e.ref, e.line]))
  const afterByRef = new Map(after.elements.map((e) => [e.ref, e.line]))
  const added: string[] = []
  const changed: string[] = []
  for (const [ref, line] of afterByRef) {
    const prev = beforeByRef.get(ref)
    if (prev === undefined) added.push(line)
    else if (prev !== line) changed.push(`${squash(prev, 60)} → ${squash(line, 60)}`)
  }
  const removed: string[] = []
  for (const [ref, line] of beforeByRef) if (!afterByRef.has(ref)) removed.push(line)

  const urlChanged = before.url !== after.url
  const prices = priceLikeChanges(before.text, after.text)
  const textChanged = prices.length > 0 || normText(before.text) !== normText(after.text)

  const parts: string[] = []
  if (urlChanged) parts.push(`moved to ${after.url}`)
  if (changed.length) parts.push(`${changed.length} element${changed.length === 1 ? "" : "s"} changed: ${changed.slice(0, 5).join("; ")}`)
  if (added.length) parts.push(`${added.length} new element${added.length === 1 ? "" : "s"} appeared: ${added.slice(0, 5).map((l) => squash(l, 60)).join(" | ")}`)
  if (removed.length) parts.push(`${removed.length} element${removed.length === 1 ? "" : "s"} disappeared: ${removed.slice(0, 5).map((l) => squash(l, 60)).join(" | ")}`)
  if (prices.length) parts.push(`text that looks like a price or availability changed: ${prices.join(" | ")}`)
  else if (!urlChanged && textChanged && !changed.length && !added.length && !removed.length) parts.push("the page text changed")

  return { changed: parts.length > 0, summary: parts.join("; ") || "nothing — the page looks the same as before" }
}

/** Resolves once the page has stopped changing for `quietMs` (or after `maxMs`) */
export function waitForQuiet(doc: Document, quietMs = 400, maxMs = 3000): Promise<void> {
  const win = winOf(doc)
  return new Promise((resolve) => {
    let timer = win.setTimeout(done, quietMs)
    const hard = win.setTimeout(done, maxMs)
    let observer: MutationObserver | null = null
    try {
      observer = new win.MutationObserver(() => {
        win.clearTimeout(timer)
        timer = win.setTimeout(done, quietMs)
      })
      observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    } catch {
      // no observer: just wait quietMs
    }
    function done() {
      win.clearTimeout(timer)
      win.clearTimeout(hard)
      observer?.disconnect()
      resolve()
    }
  })
}
