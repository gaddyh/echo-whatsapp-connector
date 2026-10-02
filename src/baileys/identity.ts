import type { NormalizedIdentity } from '../events/types.js'

function phoneFromJid(jid?: string): string | undefined {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return undefined
  return jid.split('@')[0]
}

export function normalizeIdentity(args: {
  participant?: string | null
  participantAlt?: string | null
  pushName?: string | null
}): NormalizedIdentity | undefined {
  const a = args.participant ?? undefined
  const b = args.participantAlt ?? undefined
  const lid = [a, b].find(x => x?.endsWith('@lid'))
  const phoneJid = [a, b].find(x => x?.endsWith('@s.whatsapp.net'))
  const canonicalId = lid ?? phoneJid ?? a ?? b
  if (!canonicalId) return undefined
  return {
    canonical_id: canonicalId,
    lid,
    phone_jid: phoneJid,
    phone_number: phoneFromJid(phoneJid),
    display_name: args.pushName ?? undefined
  }
}
