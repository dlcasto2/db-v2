import { NextResponse, type NextRequest } from "next/server"
import { JevError, askJev, choice, jevEnabled, noul, score } from "@/lib/jev-server"
import { PAGE_CATEGORIES, type PageCategory, type PageCheck, type PageSnapshot, type Verdict } from "@/lib/page-check"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

// ---------- Questions (all answered in one Jev call) ----------

const QUESTIONS = {
  category: choice("What kind of website page is this?", PAGE_CATEGORIES),

  phishing: noul(
    "This page imitates a real company, bank, school, game or service in order to trick visitors into entering passwords, codes, payment details or personal information.",
    {
      true: "A fake or look-alike sign-in, verification, payment or 'account suspended' page, usually on a domain the real brand doesn't own.",
      false: "A genuine page of the site it appears to be, or a page that isn't collecting sensitive details under a false identity.",
    },
  ),

  scam: noul(
    "This page is a scam: fake prizes or giveaways, fake virus or tech-support warnings, crypto or money 'doubling', fake stores, survey traps, or pressure to pay or download something urgently.",
    {
      true: "Deceptive offers, fake alerts, impossible rewards or urgent pressure to pay, call or install.",
      false: "An ordinary page with no deceptive offer or fake alert.",
    },
  ),

  brandMatch: noul(
    "The domain in the URL belongs to the organization or brand the page presents itself as (or the page doesn't present itself as any particular brand).",
    {
      true: "The page's identity and its domain agree, e.g. a Google sign-in on accounts.google.com.",
      false: "The page claims to be a brand whose official domain is different, e.g. a 'PayPal' login on paypal-secure-verify.xyz.",
    },
  ),

  trust: score("How trustworthy and reputable is this website?", [
    "Untrustworthy: deceptive, malicious, or a throwaway site",
    "Questionable: low quality, spammy, heavy on ads or pop-ups, or unclear who runs it",
    "Ordinary: a normal site with nothing suspicious",
    "Well-known and reputable organization or service",
  ]),
}

// ---------- Limits ----------

const RATE_LIMIT = 30 // checks per visitor per minute (per server instance)
const hits = new Map<string, number[]>()

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) hits.clear()
  return recent.length > RATE_LIMIT
}

const CACHE_MS = 15 * 60_000
const cache = new Map<string, { at: number; result: PageCheck }>()

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : ""
}

function parseSnapshot(body: unknown): PageSnapshot | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  const url = str(b.url, 2048)
  try {
    const u = new URL(url)
    if (u.protocol !== "http:" && u.protocol !== "https:") return null
  } catch {
    return null
  }
  return {
    url,
    title: str(b.title, 300),
    description: str(b.description, 500),
    text: str(b.text, 4000),
    hasPasswordField: b.hasPasswordField === true,
    hasCardField: b.hasCardField === true,
  }
}

// ---------- Decision logic (in code, so thresholds are easy to tune) ----------

function decide(a: {
  phishing: number
  scam: number
  brandMatch: number
  trust: number
  category: PageCategory
  asksSecrets: boolean
}): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = []
  let verdict: Verdict = "safe"
  const raise = (v: Verdict) => {
    if (v === "danger" || (v === "caution" && verdict === "safe")) verdict = v
  }

  if (a.phishing >= 0.75) {
    raise("danger")
    reasons.push("Looks like a phishing page pretending to be another site.")
  } else if (a.phishing >= 0.45) {
    raise("caution")
    reasons.push("Has some signs of a phishing page.")
  }

  if (a.scam >= 0.75) {
    raise("danger")
    reasons.push("Looks like a scam (fake offer, fake alert or pressure to pay).")
  } else if (a.scam >= 0.45) {
    raise("caution")
    reasons.push("Has some signs of a scam.")
  }

  if (a.asksSecrets && a.brandMatch < 0.3) {
    raise(a.phishing >= 0.5 ? "danger" : "caution")
    reasons.push("Asks for a password or card details, but the domain doesn't seem to match the brand shown.")
  }

  if (a.trust < 1) {
    raise("caution")
    reasons.push("Rated as an untrustworthy site.")
  }

  if (a.category === "adult" || a.category === "gambling") {
    raise("caution")
    reasons.push(a.category === "adult" ? "Adult content." : "Gambling site.")
  }

  return { verdict, reasons }
}

// ---------- Handlers ----------

export async function GET() {
  return NextResponse.json({ enabled: jevEnabled() }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(req: NextRequest) {
  if (!jevEnabled()) return NextResponse.json({ error: "Page check is not set up on this server." }, { status: 503 })

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "anon"
  if (rateLimited(ip)) return NextResponse.json({ error: "Too many page checks, try again in a minute." }, { status: 429 })

  const snap = parseSnapshot(await req.json().catch(() => null))
  if (!snap) return NextResponse.json({ error: "Invalid page snapshot." }, { status: 400 })

  const cacheKey = snap.url.split("#")[0]
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json({ ...hit.result, cached: true })

  const state = {
    url: snap.url,
    domain: new URL(snap.url).hostname,
    title: snap.title,
    description: snap.description,
    page_text: snap.text || "(no visible text)",
    has_password_field: snap.hasPasswordField,
    has_payment_card_field: snap.hasCardField,
  }

  try {
    const { model, answers } = await askJev(state, QUESTIONS)

    const category = (answers.category.choice in PAGE_CATEGORIES ? answers.category.choice : "other") as PageCategory
    const phishing = answers.phishing.noul
    const scam = answers.scam.noul
    const brandMatch = answers.brandMatch.noul
    const trust = answers.trust.score

    const { verdict, reasons } = decide({
      phishing,
      scam,
      brandMatch,
      trust,
      category,
      asksSecrets: snap.hasPasswordField || snap.hasCardField,
    })

    const result: PageCheck = {
      verdict,
      reasons,
      category,
      categoryConfidence: answers.category.confidence,
      phishing,
      scam,
      brandMatch,
      trust,
      model,
    }
    cache.set(cacheKey, { at: Date.now(), result })
    if (cache.size > 2000) cache.delete(cache.keys().next().value as string)
    return NextResponse.json(result)
  } catch (err) {
    const status = err instanceof JevError ? err.status : 500
    console.error("[jev] page check failed:", err)
    return NextResponse.json(
      { error: status === 401 ? "The Jev API key was rejected." : "Page check is unavailable right now." },
      { status: status === 401 || status === 503 ? status : 502 },
    )
  }
}
