/**
 * Masks identity-bearing values before anything leaves the process toward
 * the LLM or the ops-alert endpoint: phone-number digit runs, full UUIDs
 * (truncated to their 8-char prefix) and WhatsApp JIDs.
 */
export function redactText(text: string): string {
  return text
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      match => match.slice(0, 8)
    )
    .replace(/[\w.:-]+@(?:s\.whatsapp\.net|lid|newsletter|g\.us|c\.us)/gi, '[jid]')
    .replace(/\+?\d[\d\s\-()]{6,}\d/g, '[number]')
    .replace(/\d{7,}/g, '[number]')
}
