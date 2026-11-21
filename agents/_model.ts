/**
 * Model and gateway settings for Devon AI (private module, not a route).
 *
 * Based on TencentEdgeOne/claude-agent-starter-node (MIT). The Claude Agent SDK
 * runs the Claude CLI as a subprocess, which reads the ANTHROPIC_* variables,
 * so the AI_GATEWAY_* settings are mapped onto those names here.
 *
 * Everything reads from `context.env`; agent routes must not use process.env.
 *
 * Priority: ANTHROPIC_API_KEY (direct Anthropic API) always wins when it's
 * set, trimmed and non-empty. The Makers gateway (AI_GATEWAY_API_KEY +
 * AI_GATEWAY_BASE_URL) is used ONLY as a fallback when no Anthropic key is
 * present — never as a silent override. This means Devon AI works fully
 * without AI_GATEWAY_API_KEY/AI_GATEWAY_BASE_URL ever being set, and a
 * stray, blank, or invalid gateway key can no longer shadow a valid
 * ANTHROPIC_API_KEY and cause a confusing 401.
 */

type Env = Record<string, string | undefined>

/** Free built-in Makers model, used when falling back to the Makers AI Gateway */
const GATEWAY_DEFAULT_MODEL = "@makers/deepseek-v4-flash"
/** Used when talking to the Anthropic API directly with ANTHROPIC_API_KEY */
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-5-5"

function clean(value: string | undefined): string {
  return (value ?? "").trim()
}

function hasAnthropicKey(env: Env): boolean {
  return Boolean(clean(env.ANTHROPIC_API_KEY))
}

/**
 * True only when the gateway should be used: no direct Anthropic key is
 * present, AND both gateway variables are set and non-blank. A direct
 * ANTHROPIC_API_KEY always takes precedence — the gateway never overrides it.
 */
function usesGateway(env: Env): boolean {
  if (hasAnthropicKey(env)) return false
  return Boolean(clean(env.AI_GATEWAY_API_KEY) && clean(env.AI_GATEWAY_BASE_URL))
}

/** True when there's a key Devon AI can call a model with, by either path */
export function modelConfigured(env: Env): boolean {
  return hasAnthropicKey(env) || usesGateway(env)
}

/**
 * True when a Free Claude Code (github.com/Alishahryar1/free-claude-code)
 * server has been pointed at. FCC is an independent, AGPL-licensed local
 * proxy that fronts 60+ model providers behind an Anthropic-Messages-compatible
 * endpoint (among others), preserving native tool use and streaming — so unlike
 * Eve Agent or AirLLM, it can run through this same Claude Agent SDK path
 * rather than a bespoke adapter; see buildFccSdkEnv below. A Proxy
 * Authentication token (DEVON_FCC_API_KEY) is optional — only required if
 * the site owner's FCC instance has that setting turned on.
 */
export function fccConfigured(env: Env): boolean {
  return Boolean(clean(env.DEVON_FCC_BASE_URL))
}

/** The model name to send when FCC is the active provider: an explicit override, or the usual resolution (FCC remaps whatever model string it's given to the provider/model configured in its own Admin UI). */
export function resolveFccModelName(env: Env): string {
  return clean(env.DEVON_FCC_MODEL) || resolveModelName(env)
}

/**
 * Environment for the Claude CLI subprocess when routed through Free Claude
 * Code instead of Anthropic directly or the AI Gateway. Points the CLI's
 * ANTHROPIC_BASE_URL at the site owner's FCC instance (DEVON_FCC_BASE_URL —
 * e.g. a tunnel or reachable address for their own machine, since FCC itself
 * defaults to binding 0.0.0.0, not just loopback) and its ANTHROPIC_API_KEY
 * at FCC's own Proxy Authentication token, if one is set (DEVON_FCC_API_KEY).
 * The CLI needs some non-empty key even when FCC has no Proxy Authentication
 * configured, hence the placeholder fallback.
 */
export function buildFccSdkEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("DEVON_")) continue
    out[key] = value
  }

  out.ANTHROPIC_BASE_URL = clean(env.DEVON_FCC_BASE_URL)
  out.ANTHROPIC_API_KEY = clean(env.DEVON_FCC_API_KEY) || "free-claude-code"

  const model = resolveFccModelName(env)
  out.ANTHROPIC_SMALL_FAST_MODEL = clean(env.DEVON_FCC_SMALL_MODEL) || model
  if (clean(env.ANTHROPIC_CUSTOM_HEADERS)) out.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS

  out.CLAUDE_CONFIG_DIR = "/tmp/claude-agent-sdk"
  out.CLAUDE_CODE_TMPDIR = "/tmp"
  return out
}

export function resolveModelName(env: Env): string {
  return (
    clean(env.AI_GATEWAY_MODEL) ||
    clean(env.CLAUDE_MODEL) ||
    (usesGateway(env) ? GATEWAY_DEFAULT_MODEL : hasAnthropicKey(env) ? ANTHROPIC_DEFAULT_MODEL : GATEWAY_DEFAULT_MODEL)
  )
}

/**
 * Environment for the Claude CLI subprocess: the function's own variables
 * (PATH and friends) minus Devon's secrets, plus whichever model path is
 * active mapped onto ANTHROPIC_*, and writable config/temp directories (HOME
 * isn't writable on EdgeOne, and the CLI exits silently if it can't create
 * its config folder).
 */
export function buildSdkEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    // Devon's own settings (YouTube cookie, Jev key…) have no business in the CLI
    if (key.startsWith("DEVON_")) continue
    out[key] = value
  }

  if (usesGateway(env)) {
    out.ANTHROPIC_BASE_URL = clean(env.AI_GATEWAY_BASE_URL)
    out.ANTHROPIC_API_KEY = clean(env.AI_GATEWAY_API_KEY)
  } else if (hasAnthropicKey(env)) {
    out.ANTHROPIC_API_KEY = clean(env.ANTHROPIC_API_KEY)
    // Make sure a leftover/blank gateway base URL can never point the CLI at
    // the gateway host while a direct Anthropic key is what's actually in use.
    delete out.AI_GATEWAY_BASE_URL
    delete out.ANTHROPIC_BASE_URL
  }

  const model = resolveModelName(env)
  out.ANTHROPIC_SMALL_FAST_MODEL = clean(env.AI_GATEWAY_SMALL_MODEL) || clean(env.ANTHROPIC_SMALL_FAST_MODEL) || model
  if (clean(env.ANTHROPIC_CUSTOM_HEADERS)) out.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS

  out.CLAUDE_CONFIG_DIR = "/tmp/claude-agent-sdk"
  out.CLAUDE_CODE_TMPDIR = "/tmp"
  return out
}
