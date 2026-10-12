/**
 * Shared base64 redaction utilities for backend agents.
 *
 * The base64Image regex and recursive sanitizer are used by:
 *   - agents/chat/_stream.ts (debug event redaction)
 *   - agents/chat/index.ts (session store sanitization)
 *   - agents/history/index.ts (history response redaction)
 */

/** Matches a JSON "base64Image":"<long base64 string>" field. */
export const BASE64_IMAGE_REGEX = /"base64Image"\s*:\s*"[A-Za-z0-9+/=]{100,}"/g;

/** Placeholder used when base64Image is stripped from session/history context. */
export const IMAGE_PLACEHOLDER = '[screenshot image saved to client]';

/** Redact base64Image in a plain string (regex replacement). */
export function redactBase64InText(text: string, placeholder = IMAGE_PLACEHOLDER): string {
  if (!text.includes('base64Image')) return text;
  return text.replace(BASE64_IMAGE_REGEX, `"base64Image":"${placeholder}"`);
}

/**
 * Recursively redact base64Image fields in an arbitrary value.
 * Skips recursion early when the value clearly contains no base64Image data.
 */
export function redactBase64Deep(value: unknown, placeholder = IMAGE_PLACEHOLDER): unknown {
  if (typeof value === 'string') {
    return redactBase64InText(value, placeholder);
  }
  if (Array.isArray(value)) {
    return value.map(v => redactBase64Deep(v, placeholder));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'base64Image' && typeof val === 'string' && val.length > 100) {
        result[key] = placeholder;
      } else {
        result[key] = redactBase64Deep(val, placeholder);
      }
    }
    return result;
  }
  return value;
}
