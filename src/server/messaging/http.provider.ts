import type { EmailMessage, EmailProvider, SendOutcome, SmsMessage, SmsProvider } from './types'

/**
 * A generic JSON-over-HTTP adapter (docs/03 §8).
 *
 * Most transactional email and SMS vendors accept a bearer token and a JSON
 * body, so one adapter covers them with configuration rather than a package per
 * vendor. A vendor with a genuinely different protocol gets its own class
 * implementing the same interface — that is what the interface is for.
 *
 * Everything here is defensive on purpose. A provider that is slow, down,
 * rate-limiting, or returning HTML where JSON was promised must come back as
 * `{ ok: false }` with something a human can read. It must never throw into a
 * caller that has just posted money.
 */

const TIMEOUT_MS = 15_000

type Config = {
  name: string
  url: string
  token?: string
  from?: string
}

export class HttpEmailProvider implements EmailProvider {
  readonly name: string
  private readonly config: Config

  constructor(config: Config) {
    this.name = config.name
    this.config = config
  }

  async send(message: EmailMessage): Promise<SendOutcome> {
    return post(this.config, {
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo,
      attachments: (message.attachments ?? []).map((attachment) => ({
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        // Base64 because a PDF does not survive a JSON string otherwise.
        contentBase64: Buffer.from(attachment.content).toString('base64'),
      })),
    })
  }
}

export class HttpSmsProvider implements SmsProvider {
  readonly name: string
  private readonly config: Config

  constructor(config: Config) {
    this.name = config.name
    this.config = config
  }

  async send(message: SmsMessage): Promise<SendOutcome> {
    return post(this.config, { from: this.config.from, to: message.to, body: message.body })
  }
}

async function post(config: Config, payload: unknown): Promise<SendOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      // The body often carries the real reason ("suppressed address", "invalid
      // number"), which is exactly what the person pressing Send needs.
      const detail = (await response.text().catch(() => '')).slice(0, 300).trim()
      return {
        ok: false,
        error: `${config.name} refused the message (${response.status})${detail ? `: ${detail}` : ''}`,
      }
    }

    const body = await response.json().catch(() => null)
    return { ok: true, messageId: extractMessageId(body) }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: `${config.name} did not respond within 15 seconds.` }
    }
    return {
      ok: false,
      error: `${config.name} could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Vendors disagree about the field name; try the common ones and shrug. */
function extractMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  for (const key of ['messageId', 'MessageId', 'id', 'sid', 'message_id']) {
    const value = raw[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}
