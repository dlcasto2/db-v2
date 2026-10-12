/**
 * Prompt Gen: turns a rough idea into a few ready-to-use prompts, entirely in
 * the browser. Each prompt type has a bank of prompt shapes; a seed picks
 * three of them and the wording, so "Remix" gives a fresh set every time and
 * the same seed always gives the same set.
 */

export type PromptType = "ask" | "write" | "code" | "image" | "study" | "plan"
export type Tone = "friendly" | "professional" | "playful" | "direct"
export type Detail = "brief" | "balanced" | "in-depth"

export interface PromptOptions {
  idea: string
  type: PromptType
  tone: Tone
  detail: Detail
  /** Who it's for, e.g. "a 7th grader" (optional) */
  audience: string
  seed: number
}

export interface GeneratedPrompt {
  /** Which shape this prompt uses */
  label: string
  text: string
}

export const PROMPT_TYPES: { id: PromptType; label: string; hint: string; example: string }[] = [
  { id: "ask", label: "Ask", hint: "Get an answer or explanation", example: "how black holes form" },
  { id: "write", label: "Write", hint: "Stories, essays, messages, poems", example: "a robot who learns to paint" },
  { id: "code", label: "Code", hint: "Programs, scripts, websites", example: "a to-do list web page that saves in the browser" },
  { id: "image", label: "Image", hint: "Prompts for image generators", example: "a lighthouse on a floating island" },
  { id: "study", label: "Study", hint: "Tutoring, quizzes, flashcards", example: "the causes of World War I" },
  { id: "plan", label: "Plan", hint: "Plans, schedules, decisions", example: "training for a 5K in two months" },
]

export const TONES: { id: Tone; label: string }[] = [
  { id: "friendly", label: "Friendly" },
  { id: "professional", label: "Professional" },
  { id: "playful", label: "Playful" },
  { id: "direct", label: "Direct" },
]

export const DETAILS: { id: Detail; label: string }[] = [
  { id: "brief", label: "Brief" },
  { id: "balanced", label: "Balanced" },
  { id: "in-depth", label: "In-depth" },
]

// ---------------------------------------------------------------------------
// Randomness (mulberry32: small, fast, repeatable from a seed)
// ---------------------------------------------------------------------------

type Rng = () => number

function rngFrom(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]
}

/** n distinct items, in random order */
function pickSome<T>(rng: Rng, items: readonly T[], n: number): T[] {
  const pool = [...items]
  const out: T[] = []
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
  return out
}

export function newSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

const TONE_LINES: Record<Tone, string[]> = {
  friendly: ["Keep the tone warm and friendly.", "Use a friendly, encouraging tone.", "Sound like a helpful friend, not a textbook."],
  professional: ["Keep the tone clear and professional.", "Write in a polished, professional voice.", "Use a confident, professional tone."],
  playful: ["Make it fun and a little playful.", "Feel free to be playful with the wording.", "Add some humor where it fits."],
  direct: ["Be direct — no filler.", "Get straight to the point.", "Skip the intro and keep every sentence useful."],
}

const DETAIL_LINES: Record<Detail, string[]> = {
  brief: ["Keep it short: a few sentences or bullet points.", "Aim for something I can read in under a minute.", "Keep it brief and focused on what matters most."],
  balanced: ["Be complete without going overboard.", "Aim for medium length: thorough but focused.", "Cover the important parts and skip the minor ones."],
  "in-depth": [
    "Go in depth: cover the details, examples and edge cases.",
    "Be thorough and explain the reasoning behind each point.",
    "Take your time and go deep, with examples throughout.",
  ],
}

const AUDIENCE_LINES = ["Write it for {a}.", "Pitch it at the level of {a}.", "My audience is {a}, so adjust the vocabulary to fit."]

const CLARIFY_LINES = [
  "If something important is unclear, ask me one question before you start.",
  "If you need to assume something, say what you assumed.",
  "",
]

/** "a story about cats." → "a story about cats" */
function cleanIdea(idea: string): string {
  return idea.trim().replace(/\s+/g, " ").replace(/[.!?。]+$/u, "")
}

function finishLines(rng: Rng, opts: PromptOptions, extra: string[] = []): string {
  const lines = [...extra, pick(rng, TONE_LINES[opts.tone]), pick(rng, DETAIL_LINES[opts.detail])]
  const audience = opts.audience.trim()
  if (audience) lines.push(pick(rng, AUDIENCE_LINES).replace("{a}", audience))
  const clarify = pick(rng, CLARIFY_LINES)
  if (clarify) lines.push(clarify)
  return lines.join(" ")
}

// ---------------------------------------------------------------------------
// Prompt shapes per type
// ---------------------------------------------------------------------------

type Shape = { label: string; build: (idea: string, rng: Rng, opts: PromptOptions) => string }

const ASK: Shape[] = [
  {
    label: "Expert explainer",
    build: (idea, rng, o) =>
      `${pick(rng, ["You're an expert who's great at explaining things clearly.", "Act as a patient expert in this subject."])} ` +
      `Explain ${idea}. Start with a one-sentence answer, then explain why. ${finishLines(rng, o)}`,
  },
  {
    label: "Step by step",
    build: (idea, rng, o) =>
      `Walk me through ${idea} step by step. Number each step, and finish with a quick real-world example. ${finishLines(rng, o)}`,
  },
  {
    label: "Plain words first",
    build: (idea, rng, o) =>
      `I want to understand ${idea}. First say what it is in plain words, then the most common misconception about it, ` +
      `then one question I should ask next to go deeper. ${finishLines(rng, o)}`,
  },
  {
    label: "Analogy",
    build: (idea, rng, o) =>
      `Explain ${idea} using an everyday analogy, then connect it back to the real thing — where the analogy holds and where it breaks down. ${finishLines(rng, o)}`,
  },
  {
    label: "Structured answer",
    build: (idea, rng, o) =>
      `Answer this: ${idea}.\n\nFormat:\n- **Short answer** (1–2 sentences)\n- **Details**\n- **Where to check** (the kinds of sources that cover this; don't make up links)\n\n${finishLines(rng, o)}`,
  },
]

const WRITE: Shape[] = [
  {
    label: "Short story",
    build: (idea, rng, o) =>
      `Write a short story about ${idea}. Give it a clear beginning, a turning point and a satisfying ending. ` +
      `${pick(rng, ["Use vivid details and at least one line of dialogue.", "Show, don't tell, and give the main character a clear goal."])} ${finishLines(rng, o)}`,
  },
  {
    label: "Essay",
    build: (idea, rng, o) =>
      `Write an essay on ${idea}. First give a three-point outline, then the full draft with an opening that hooks the reader ` +
      `and a conclusion that ties back to it. ${finishLines(rng, o)}`,
  },
  {
    label: "Persuasive",
    build: (idea, rng, o) =>
      `Write a persuasive piece about ${idea}. Lead with the strongest point, answer one objection fairly, and end with a clear call to action. ${finishLines(rng, o)}`,
  },
  {
    label: "Poem",
    build: (idea, rng, o) =>
      `Write an original poem about ${idea}. Pick the form that fits best (${pick(rng, ["free verse, rhyming couplets or a sonnet", "haiku sequence, ballad or free verse"])}) and tell me which you chose. ${finishLines(rng, o)}`,
  },
  {
    label: "Two versions",
    build: (idea, rng, o) =>
      `Write a message about ${idea}. Give me two versions: a short one and a slightly longer one, so I can pick. ${finishLines(rng, o)}`,
  },
]

const CODE: Shape[] = [
  {
    label: "Senior developer",
    build: (idea, rng, o) =>
      `You're a senior developer. Write code for this: ${idea}. Use clear names, add brief comments, and explain how to run it. ${finishLines(rng, o, [
        "Say which language you chose and why, unless I named one.",
      ])}`,
  },
  {
    label: "Plan, then code",
    build: (idea, rng, o) =>
      `I want to build ${idea}. First list the parts you'll write, then write the code, then show an example input and its output. ${finishLines(rng, o)}`,
  },
  {
    label: "With tests",
    build: (idea, rng, o) =>
      `Write code for ${idea}, plus a few test cases that prove it works. Point out the edge cases you handled. ${finishLines(rng, o)}`,
  },
  {
    label: "Beginner friendly",
    build: (idea, rng, o) =>
      `Help me code ${idea} as a beginner. Write the simplest version that works, explain each part, then suggest one improvement I could try myself. ${finishLines(rng, o)}`,
  },
  {
    label: "Robust version",
    build: (idea, rng, o) =>
      `Write ${idea}. Handle errors and bad input gracefully, and finish with a short list of common bugs to watch for. ${finishLines(rng, o)}`,
  },
]

const IMAGE_STYLES = [
  "digital painting",
  "watercolor",
  "cinematic photography",
  "3D render",
  "pixel art",
  "hand-painted animation",
  "paper cut-out collage",
  "isometric illustration",
]
const IMAGE_LIGHT = ["soft morning light", "golden-hour sunlight", "neon light", "dramatic rim lighting", "soft overcast light", "moonlight"]
const IMAGE_FRAMING = ["wide shot", "close-up", "low angle", "centered composition", "rule of thirds", "bird's-eye view"]
const IMAGE_MOOD: Record<Tone, string[]> = {
  friendly: ["warm colors", "cozy atmosphere"],
  professional: ["clean and minimal", "balanced, muted palette"],
  playful: ["bright colors", "whimsical details"],
  direct: ["sharp focus", "simple background"],
}
const IMAGE_DETAIL: Record<Detail, string> = { brief: "", balanced: "detailed", "in-depth": "highly detailed, intricate textures" }
/** Shots that read naturally as "A <shot> of …" */
const IMAGE_SHOTS = ["wide shot", "close-up", "low-angle shot", "bird's-eye view", "centered portrait", "over-the-shoulder view"]
const SCENE_DETAIL: Record<Detail, string> = { brief: "", balanced: "plenty of detail", "in-depth": "intricate textures and fine detail everywhere" }

const IMAGE: Shape[] = [
  {
    label: "Comma-style prompt",
    build: (idea, rng, o) =>
      [idea, pick(rng, IMAGE_STYLES), pick(rng, IMAGE_LIGHT), pick(rng, IMAGE_FRAMING), pick(rng, IMAGE_MOOD[o.tone]), IMAGE_DETAIL[o.detail]]
        .filter(Boolean)
        .join(", "),
  },
  {
    label: "Detailed brief",
    build: (idea, rng, o) =>
      `Create an image of ${idea}.\nStyle: ${pick(rng, IMAGE_STYLES)}\nLighting: ${pick(rng, IMAGE_LIGHT)}\nFraming: ${pick(rng, IMAGE_FRAMING)}\n` +
      `Mood: ${pickSome(rng, IMAGE_MOOD[o.tone], 2).join(", ")}\nAvoid: blurry details, warped hands, stray text${o.detail === "in-depth" ? "\nInclude small background details that reward a close look." : ""}`,
  },
  {
    label: "Four variations",
    build: (idea, rng) => {
      const styles = pickSome(rng, IMAGE_STYLES, 4)
      return `Generate four variations of ${idea}, keeping the main subject the same:\n${styles.map((s, i) => `${i + 1}. ${s}, ${pick(rng, IMAGE_LIGHT)}`).join("\n")}`
    },
  },
  {
    label: "Scene description",
    build: (idea, rng, o) =>
      `A ${pick(rng, IMAGE_SHOTS)} of ${idea}, in a ${pick(rng, IMAGE_STYLES)} style. The scene is lit by ${pick(rng, IMAGE_LIGHT)}, ` +
      `with ${pick(rng, IMAGE_MOOD[o.tone])}${SCENE_DETAIL[o.detail] ? ` and ${SCENE_DETAIL[o.detail]}` : ""}.`,
  },
]

const STUDY: Shape[] = [
  {
    label: "Tutor",
    build: (idea, rng, o) =>
      `Be my tutor for ${idea}. Teach it in short chunks, and after each chunk ask me one question to check I understood before moving on. ${finishLines(rng, o)}`,
  },
  {
    label: "Quiz me",
    build: (idea, rng, o) =>
      `Make a ${pick(rng, ["10", "8", "12"])}-question quiz on ${idea}, mixing multiple choice and short answer. Put the answer key at the end with a one-line explanation for each. ${finishLines(rng, o)}`,
  },
  {
    label: "Study guide",
    build: (idea, rng, o) =>
      `Create a one-page study guide on ${idea}: key terms with definitions, the five most important ideas, and a memory trick for the hardest one. ${finishLines(rng, o)}`,
  },
  {
    label: "Flashcards",
    build: (idea, rng, o) =>
      `Turn ${idea} into ${pick(rng, ["15", "20", "12"])} flashcards in a two-column table (Front | Back), one fact per card. ${finishLines(rng, o)}`,
  },
  {
    label: "Explain it back",
    build: (idea, rng, o) =>
      `Use the Feynman technique on ${idea}: explain it simply, point out where the simple version leaves gaps, then fill them in. ${finishLines(rng, o)}`,
  },
]

const PLAN: Shape[] = [
  {
    label: "Phased plan",
    build: (idea, rng, o) =>
      `Make a step-by-step plan for ${idea}. Split it into phases with concrete tasks, and estimate how long each phase takes. ${finishLines(rng, o)}`,
  },
  {
    label: "Checklist",
    build: (idea, rng, o) =>
      `Turn ${idea} into a checklist I can tick off, grouped by category, with the most important items first. ${finishLines(rng, o)}`,
  },
  {
    label: "Decision helper",
    build: (idea, rng, o) =>
      `Help me decide about ${idea}: list the realistic options, the pros and cons of each, and recommend one with your reasoning. ${finishLines(rng, o)}`,
  },
  {
    label: "Weekly schedule",
    build: (idea, rng, o) =>
      `Create a weekly schedule for ${idea} that fits around school or work, with realistic time blocks and a rest day. ${finishLines(rng, o)}`,
  },
  {
    label: "Brainstorm",
    build: (idea, rng, o) =>
      `Brainstorm ${pick(rng, ["10", "12", "8"])} ideas for ${idea}, from safe to wild. Mark your top three and say why. ${finishLines(rng, o)}`,
  },
]

const SHAPES: Record<PromptType, Shape[]> = { ask: ASK, write: WRITE, code: CODE, image: IMAGE, study: STUDY, plan: PLAN }

/** Three prompts for the idea, chosen and worded by the seed */
export function generatePrompts(opts: PromptOptions, count = 3): GeneratedPrompt[] {
  const idea = cleanIdea(opts.idea)
  if (!idea) return []
  const rng = rngFrom(opts.seed)
  return pickSome(rng, SHAPES[opts.type], count).map((shape) => ({
    label: shape.label,
    text: shape.build(idea, rng, opts).replace(/ {2,}/g, " ").trim(),
  }))
}
