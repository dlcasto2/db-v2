/**
 * Server-only client for Jev, TypeSafe AI's System One decision model.
 *
 * Jev takes a `state` plus named, typed questions and returns probabilities
 * instead of text:
 *   - choice: pick one option from a map            → choice, probabilities, confidence
 *   - score:  place the state on an ordered rubric  → score (0..levels-1), probabilities, confidence
 *   - noul:   is a statement true?                  → noul (0..1)
 *
 * Docs: https://docs.typesafe.ai/api
 *
 * Settings (same lookup as the YouTube settings: runtime variable first, then the
 * value baked in at build time through DEVON_BUILD_ENV):
 *   DEVON_JEV_API_KEY   TypeSafe key, or an OpenRouter key when the backend is openrouter
 *   DEVON_JEV_BACKEND   "typesafe" (default) or "openrouter"
 *   DEVON_JEV_MODEL     defaults to jev-latest (typesafe/jev-1.13 on OpenRouter)
 *   DEVON_JEV_BASE_URL  optional full endpoint override (a gateway, or a mock for testing)
 *
 * This file must never be imported from client code: it reads the API key.
 */

// ---------- Types (mirror the public API) ----------

type Instructions = string | Record<string, unknown> | unknown[]

export interface NoulQuestion {
  type: "noul"
  instructions: Instructions
  criteria?: { true?: Instructions; false?: Instructions }
}

export interface ChoiceQuestion<O extends string = string> {
  type: "choice"
  instructions: Instructions
  /** Option name → description. Max 255 options. */
  criteria: Record<O, Instructions | null>
}

export interface ScoreQuestion {
  type: "score"
  instructions: Instructions
  /** Ordered level descriptions, level 0 first. 2–10 levels. */
  criteria: Instructions[]
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  type: "noul"
  noul: number
}

export interface ChoiceAnswer<O extends string = string> {
  type: "choice"
  choice: O
  probabilities: Record<O, number>
  confidence: number
}

export interface ScoreAnswer {
  type: "score"
  score: number
  legend: Record<string, unknown>
  probabilities: Record<string, number>
  confidence: number
}

/** Maps each question to the answer type it produces */
export type AnswerFor<Q> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer O>
    ? ChoiceAnswer<O>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never

export interface JevResult<Qs extends Record<string, JevQuestion>> {
  model: string
  answers: { [K in keyof Qs]: AnswerFor<Qs[K]> }
  usage?: { input_tokens: number; output_tokens: number }
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "JevError"
  }
}

// Small helpers so call sites read like the official SDK
export const noul = (instructions: Instructions, criteria?: NoulQuestion["criteria"]): NoulQuestion =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions }

export const choice = <O extends string>(
  instructions: Instructions,
  criteria: Record<O, Instructions | null>,
): ChoiceQuestion<O> => ({ type: "choice", instructions, criteria })

export const score = (instructions: Instructions, criteria: Instructions[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
})

// ---------- Settings ----------

const RUNTIME_ENV: Record<string, string | undefined> = (() => {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    return proc?.env ?? {}
  } catch {
    return {}
  }
})()

const BUILD_ENV: Record<string, string> = (() => {
  try {
    return JSON.parse(process.env.DEVON_BUILD_ENV || "{}")
  } catch {
    return {}
  }
})()

function setting(name: string): string | undefined {
  const raw = RUNTIME_ENV[name]?.trim() ? RUNTIME_ENV[name] : BUILD_ENV[name]
  if (!raw) return undefined
  let v = raw.trim()
  while (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) v = v.slice(1, -1).trim()
  return v || undefined
}

const BACKENDS = {
  typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  openrouter: { url: "https://openrouter.ai/api/v1/systemone", model: "typesafe/jev-1.13" },
} as const

function config() {
  const key = setting("DEVON_JEV_API_KEY")
  const backendName = setting("DEVON_JEV_BACKEND") === "openrouter" ? "openrouter" : "typesafe"
  const backend = BACKENDS[backendName]
  return { key, backendName, url: setting("DEVON_JEV_BASE_URL") || backend.url, model: setting("DEVON_JEV_MODEL") || backend.model }
}

export function jevEnabled(): boolean {
  return Boolean(config().key)
}

// ---------- Call ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * One request: every question is evaluated against `state` in parallel.
 * Retries 429 / 529 / 5xx with exponential backoff, as the docs recommend.
 */
export async function askJev<Qs extends Record<string, JevQuestion>>(
  state: string | Record<string, unknown> | unknown[],
  questions: Qs,
  { timeoutMs = 8000, retries = 2 }: { timeoutMs?: number; retries?: number } = {},
): Promise<JevResult<Qs>> {
  const { key, url, model } = config()
  if (!key) throw new JevError("Jev is not configured (set DEVON_JEV_API_KEY)", 503)

  const body = JSON.stringify({ model, state, questions })
  let lastError: JevError | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1) + Math.random() * 150)
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      lastError = new JevError(err instanceof Error ? err.message : "Network error", 502)
      continue
    }

    if (res.ok) return (await res.json()) as JevResult<Qs>

    const detail = await res.text().catch(() => "")
    lastError = new JevError(`Jev ${res.status}: ${detail.slice(0, 300)}`, res.status)
    if (!(res.status === 429 || res.status === 529 || res.status >= 500)) break // 401/422: retrying won't help
  }
  throw lastError ?? new JevError("Jev request failed", 502)
}
