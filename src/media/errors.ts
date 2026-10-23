/**
 * Typed media download failures.
 *
 * These errors let the HTTP layer and the session retry loop distinguish
 * deterministic failures (missing payload, oversized file) from transient
 * download errors that may recover on a bounded retry.
 *
 * None of these errors carry media keys or media bytes — only a short,
 * generic message suitable for structured logs and external responses.
 */

/** The WhatsApp message lacks the metadata required to decrypt the media. */
export class MediaPayloadIncompleteError extends Error {
  constructor(message = 'message media payload is incomplete') {
    super(message)
    this.name = 'MediaPayloadIncompleteError'
  }
}

/** The downloaded media exceeded the configured size limit. */
export class MediaTooLargeError extends Error {
  constructor(message = 'media exceeds configured size limit') {
    super(message)
    this.name = 'MediaTooLargeError'
  }
}

/** A transient failure while downloading media from WhatsApp. */
export class MediaDownloadError extends Error {
  constructor(message = 'media download failed', cause?: unknown) {
    super(message)
    this.name = 'MediaDownloadError'
    if (cause !== undefined) (this as any).cause = cause
  }
}
