/**
 * Model and gateway settings for Devon AI (private module, not a route).
 *
 * Based on TencentEdgeOne/claude-agent-starter-node (MIT). The Claude Agent SDK
 * runs the Claude CLI as a subprocess, which reads the ANTHROPIC_* variables,
 * so the AI_GATEWAY_* settings are mapped onto those names here.
 *
 * Everything reads from `context.env`; agent routes must not use process.env.
 */

type Env = Record<string, string | undefined>

/** Free built-in Makers model, used when going through the Makers AI Gateway */
const GATEWAY_DEFAULT_MODEL = "@makers/deepseek-v4-flash"
/** Used when talking to the Anthropic API directly with ANTHROPIC_API_KEY */
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-5-5"

function usesGateway(env: Env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL)
}

/** True when there's a key Devon AI can call a model with */
export function modelConfigured(env: Env): boolean {
  return usesGateway(env) || Boolean(env.ANTHROPIC_API_KEY)
}

export function resolveModelName(env: Env): string {
  return (
    env.AI_GATEWAY_MODEL ||
    env.CLAUDE_MODEL ||
    (usesGateway(env) ? GATEWAY_DEFAULT_MODEL : env.ANTHROPIC_API_KEY ? ANTHROPIC_DEFAULT_MODEL : GATEWAY_DEFAULT_MODEL)
  )
}

/**
 * Environment for the Claude CLI subprocess: the function's own variables
 * (PATH and friends) minus Devon's secrets, plus the gateway mapped onto
 * ANTHROPIC_* and writable config/temp directories (HOME isn't writable on
 * EdgeOne, and the CLI exits silently if it can't create its config folder).
 */
export function buildSdkEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    // Devon's own settings (YouTube cookie, Jev key…) have no business in the CLI
    if (key.startsWith("DEVON_")) continue
    out[key] = value
  }

  if (usesGateway(env)) {
    out.ANTHROPIC_BASE_URL = env.AI_GATEWAY_BASE_URL
    out.ANTHROPIC_API_KEY = env.AI_GATEWAY_API_KEY
  }
  const model = resolveModelName(env)
  out.ANTHROPIC_SMALL_FAST_MODEL = env.AI_GATEWAY_SMALL_MODEL || env.ANTHROPIC_SMALL_FAST_MODEL || model
  if (env.ANTHROPIC_CUSTOM_HEADERS) out.ANTHROPIC_CUSTOM_HEADERS = env.ANTHROPIC_CUSTOM_HEADERS

  out.CLAUDE_CONFIG_DIR = "/tmp/claude-agent-sdk"
  out.CLAUDE_CODE_TMPDIR = "/tmp"
  return out
}
