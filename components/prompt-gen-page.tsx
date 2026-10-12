"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, Check, Copy, Shuffle, Sparkles, WandSparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DETAILS,
  type Detail,
  PROMPT_TYPES,
  type PromptType,
  TONES,
  type Tone,
  generatePrompts,
  newSeed,
} from "@/lib/prompt-gen"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "devon_prompt_gen"

interface Saved {
  idea: string
  type: PromptType
  tone: Tone
  detail: Detail
  audience: string
  /** null until Generate is pressed */
  seed: number | null
}

const DEFAULTS: Saved = { idea: "", type: "ask", tone: "friendly", detail: "balanced", audience: "", seed: null }

function load(): Saved {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<Saved> | null
    if (!raw || typeof raw !== "object") return DEFAULTS
    return {
      idea: typeof raw.idea === "string" ? raw.idea : "",
      type: PROMPT_TYPES.some((t) => t.id === raw.type) ? (raw.type as PromptType) : DEFAULTS.type,
      tone: TONES.some((t) => t.id === raw.tone) ? (raw.tone as Tone) : DEFAULTS.tone,
      detail: DETAILS.some((d) => d.id === raw.detail) ? (raw.detail as Detail) : DEFAULTS.detail,
      audience: typeof raw.audience === "string" ? raw.audience : "",
      seed: typeof raw.seed === "number" ? raw.seed : null,
    }
  } catch {
    return DEFAULTS
  }
}

/** Prompt Gen (devon://apps/prompt-gen): an offline prompt remixer */
export function PromptGenPage({ onOpenApps, onSendToAi }: { onOpenApps: () => void; onSendToAi: (prompt: string) => void }) {
  const [s, setS] = useState<Saved>(DEFAULTS)
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)

  useEffect(() => {
    setS(load())
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      // private mode
    }
  }, [s, loaded])

  const prompts = useMemo(
    () => (s.seed === null ? [] : generatePrompts({ idea: s.idea, type: s.type, tone: s.tone, detail: s.detail, audience: s.audience, seed: s.seed })),
    [s],
  )
  const typeInfo = PROMPT_TYPES.find((t) => t.id === s.type)!
  const canGenerate = s.idea.trim().length > 0

  const update = (patch: Partial<Saved>) => setS((prev) => ({ ...prev, ...patch }))
  const generate = () => canGenerate && update({ seed: newSeed() })

  const copy = (text: string, i: number) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(i)
      setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200)
    })
  }

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-11 flex-shrink-0 items-center gap-2 border-b border-border px-3">
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3" onClick={onOpenApps}>
          <ArrowLeft /> Apps
        </Button>
        <span className="ml-1 grid size-6 place-items-center rounded-lg bg-teal-400/15 text-teal-300 ring-1 ring-teal-400/30">
          <WandSparkles className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Prompt Gen</span>
        <span className="hidden rounded-full px-2.5 py-1 text-[11px] text-muted-foreground ring-1 ring-border sm:inline">
          Works offline
        </span>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[300px] bg-[radial-gradient(ellipse_60%_60%_at_50%_0%,oklch(0.78_0.12_180/0.12),transparent)]" />
        <div className="relative mx-auto w-full max-w-3xl py-8">
          <h1 className="text-2xl font-semibold tracking-tight">Turn an idea into a great prompt</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Write what you want, pick a type, and get three prompts to copy into any AI — or send straight to Devon AI.
          </p>

          <form
            className="mt-6 space-y-5"
            onSubmit={(e) => {
              e.preventDefault()
              generate()
            }}
          >
            <div>
              <label htmlFor="pg-idea" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Your idea
              </label>
              <textarea
                id="pg-idea"
                value={s.idea}
                onChange={(e) => update({ idea: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    generate()
                  }
                }}
                rows={3}
                maxLength={600}
                placeholder={`e.g. ${typeInfo.example}`}
                className="w-full resize-none rounded-xl bg-toolbar px-4 py-3 text-[14px] text-foreground ring-1 ring-border outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60"
              />
            </div>

            <fieldset>
              <legend className="mb-1.5 block text-xs font-medium text-muted-foreground">Type</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PROMPT_TYPES.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => update({ type: t.id })}
                    aria-pressed={s.type === t.id}
                    className={cn(
                      "rounded-xl px-3 py-2.5 text-left ring-1 transition",
                      s.type === t.id ? "bg-primary/15 ring-primary/50" : "bg-toolbar ring-border hover:ring-primary/30",
                    )}
                  >
                    <span className="block text-sm font-medium">{t.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{t.hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-5 sm:grid-cols-2">
              <Choice label="Tone" options={TONES} value={s.tone} onChange={(tone) => update({ tone })} />
              <Choice label="Detail" options={DETAILS} value={s.detail} onChange={(detail) => update({ detail })} />
            </div>

            <div>
              <label htmlFor="pg-audience" className="mb-1.5 block text-xs font-medium text-muted-foreground">
                For who? <span className="text-muted-foreground/60">(optional)</span>
              </label>
              <input
                id="pg-audience"
                value={s.audience}
                onChange={(e) => update({ audience: e.target.value })}
                maxLength={80}
                placeholder="e.g. a 7th grader, my boss, total beginners"
                className="h-10 w-full rounded-xl bg-toolbar px-4 text-[14px] ring-1 ring-border outline-none transition placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/60"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="h-10 rounded-full px-5" disabled={!canGenerate}>
                <Sparkles /> {prompts.length ? "Generate new set" : "Generate"}
              </Button>
              {prompts.length > 0 && (
                <Button type="button" variant="secondary" className="h-10 rounded-full px-4" onClick={generate} title="Same idea, new wording">
                  <Shuffle /> Remix
                </Button>
              )}
            </div>
          </form>

          {prompts.length > 0 && (
            <div className="mt-8 space-y-3" aria-live="polite">
              {prompts.map((p, i) => (
                <div key={`${s.seed}-${i}`} className="rounded-2xl bg-toolbar p-4 ring-1 ring-border">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">{p.label}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/90">{p.text}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" className="h-8 rounded-full" onClick={() => copy(p.text, i)}>
                      {copied === i ? <Check /> : <Copy />} {copied === i ? "Copied" : "Copy"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8 rounded-full" onClick={() => onSendToAi(p.text)}>
                      <Sparkles /> Send to Devon AI
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            type="button"
            key={o.id}
            onClick={() => onChange(o.id)}
            aria-pressed={value === o.id}
            className={cn(
              "rounded-full px-3 py-1.5 text-[13px] ring-1 transition",
              value === o.id ? "bg-primary/15 text-foreground ring-primary/50" : "text-muted-foreground ring-border hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
