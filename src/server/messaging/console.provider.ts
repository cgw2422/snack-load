import type { EmailMessage, EmailProvider, SendOutcome, SmsMessage, SmsProvider } from './types'

/**
 * The development adapter. Writes the message to the server log and reports
 * success, so the whole delivery path — log rows, share links, the UI — can be
 * exercised without an account anywhere.
 *
 * `index.ts` refuses to select this in production.
 */

export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console'

  async send(message: EmailMessage): Promise<SendOutcome> {
    const attachments = (message.attachments ?? [])
      .map((a) => `${a.fileName} (${a.content.byteLength} bytes)`)
      .join(', ')

    console.info(
      [
        '',
        '─── email (console provider — nothing was actually sent) ───',
        `  to:      ${message.to}`,
        `  subject: ${message.subject}`,
        attachments ? `  files:   ${attachments}` : null,
        '',
        message.text.replace(/^/gm, '  '),
        '───────────────────────────────────────────────────────────',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    )
    return { ok: true, messageId: `console-${Date.now()}` }
  }
}

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console'

  async send(message: SmsMessage): Promise<SendOutcome> {
    console.info(
      [
        '',
        '─── sms (console provider — nothing was actually sent) ───',
        `  to: ${message.to}`,
        '',
        message.body.replace(/^/gm, '  '),
        '─────────────────────────────────────────────────────────',
      ].join('\n'),
    )
    return { ok: true, messageId: `console-${Date.now()}` }
  }
}
