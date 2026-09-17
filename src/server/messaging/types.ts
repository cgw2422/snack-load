/**
 * The messaging seam (docs/03 §8).
 *
 * SnackLoad sends two kinds of message and knows nothing about who carries
 * them. Everything vendor-specific lives behind these two interfaces, so
 * changing email or SMS provider is a new adapter plus a config value — not a
 * search through the codebase for the places that hardcoded a vendor's SDK.
 *
 * `send` never throws for an ordinary delivery failure. A bounced address or a
 * provider outage is a normal outcome that the caller logs and shows; it must
 * not unwind the transaction that produced the document (docs/02 §A5). Only a
 * programming error — a malformed call — is allowed to raise.
 */

export type SendOutcome =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string }

export type EmailAttachment = {
  fileName: string
  contentType: string
  content: Uint8Array
}

export type EmailMessage = {
  to: string
  subject: string
  text: string
  html: string
  replyTo?: string
  attachments?: EmailAttachment[]
}

export interface EmailProvider {
  /** Shown in the delivery log, so history stays legible across a vendor switch. */
  readonly name: string
  send(message: EmailMessage): Promise<SendOutcome>
}

export type SmsMessage = {
  to: string
  body: string
}

export interface SmsProvider {
  readonly name: string
  send(message: SmsMessage): Promise<SendOutcome>
}
