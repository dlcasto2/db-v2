/**
 * Demo tools for the OpenAI Agents provider — private module, not a route.
 *
 * Ported from TencentEdgeOne/openai-agents-starter-node's agents/_tools.ts
 * (MIT). All four return mock data; swap an `execute` body for a real API
 * call when you want this provider to do more than demonstrate tool use.
 */

import { tool } from "@openai/agents"
import { z } from "zod"

const getWeather = tool({
  name: "get_weather",
  description:
    "Fetch the current weather for one specific city. This tool ONLY returns weather data — it does NOT give " +
    "clothing advice. When asked \"what should I wear in <city>\", call this tool first, then call " +
    "get_clothing_advice separately with the JSON returned here.",
  parameters: z.object({
    city: z.string().describe("The city to get weather for"),
  }),
  execute: async ({ city }) => {
    // Mock data — replace with a real weather API (e.g. OpenWeatherMap, wttr.in)
    return JSON.stringify({
      city,
      condition: "Sunny",
      temperature: { min: 18, max: 25, unit: "°C" },
      wind: "Light breeze",
    })
  },
})

const getClothingAdvice = tool({
  name: "get_clothing_advice",
  description:
    "Give clothing advice based on a weather description the caller already has. This tool does NOT fetch " +
    "weather itself — call get_weather first if the question names a city, then pass the result (or any plain-text " +
    "weather summary) in. There is no combined \"get_clothing_weather\" tool.",
  parameters: z.object({
    weather: z.string().describe("The weather description (JSON or plain text)"),
  }),
  execute: async ({ weather }) => {
    const cold = /(-\d|[0-9](?=\s*°))/
    const hot = /(3[0-9]|4[0-9])\s*°/
    if (hot.test(weather)) return "Hot weather — wear short sleeves, shorts, and stay hydrated."
    if (cold.test(weather)) return "Cold weather — wear a down jacket or heavy coat with scarf and gloves."
    return "Moderate weather — a light jacket with casual pants and sneakers works well."
  },
})

const translateText = tool({
  name: "translate_text",
  description: "Translate text to the specified language.",
  parameters: z.object({
    text: z.string().describe("The text to translate"),
    target_language: z.string().describe("Target language code, e.g. en, ja, fr, ko, de"),
  }),
  execute: async ({ text, target_language }) => {
    // Mock translation — replace with a real translation API (DeepL, Google Translate…)
    const languageNames: Record<string, string> = { en: "English", ja: "日本語", fr: "Français", ko: "한국어", de: "Deutsch", es: "Español", ru: "Русский" }
    const langName = languageNames[target_language] ?? target_language
    return `[Mock translation to ${langName}]: ${text}`
  },
})

const textStatistics = tool({
  name: "text_statistics",
  description: "Analyze text and return statistics like character count and word count.",
  parameters: z.object({
    text: z.string().describe("The text to analyze"),
  }),
  execute: async ({ text }) => {
    const charCount = text.length
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length
    const lineCount = text.split("\n").length
    return JSON.stringify({ charCount, wordCount, lineCount })
  },
})

/** Factory so every run gets its own tool instances. */
export function createOpenaiDemoTools() {
  return [getWeather, getClothingAdvice, translateText, textStatistics]
}
