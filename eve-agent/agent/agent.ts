import { defineAgent } from "eve"
import { anthropic } from "eve/models/anthropic"

/**
 * Eve is the selectable agent runtime in Devon AI. Its underlying model uses
 * Eve's direct Anthropic provider, so ANTHROPIC_API_KEY is sufficient and
 * does not silently depend on a separate AI Gateway credential.
 */
export default defineAgent({
  model: anthropic(process.env.DEVON_EVE_MODEL?.trim() || "claude-sonnet-5"),
  reasoning: "medium",
})
