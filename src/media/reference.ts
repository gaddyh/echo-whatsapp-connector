export function mediaReference(connectionId: string, providerMessageId: string): string {
  return `baileys:${connectionId}:${providerMessageId}`
}
