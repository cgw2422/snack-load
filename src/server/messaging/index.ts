import { env } from '@/lib/env'
import type { EmailProvider, SmsProvider } from './types'
import { ConsoleEmailProvider, ConsoleSmsProvider } from './console.provider'
import { HttpEmailProvider, HttpSmsProvider } from './http.provider'

export type {
  EmailAttachment,
  EmailMessage,
  EmailProvider,
  SendOutcome,
  SmsMessage,
  SmsProvider,
} from './types'

/**
 * Provider selection (docs/03 §8).
 *
 * Configuration picks the adapter; nothing else in the codebase names a vendor.
 * With nothing configured the console provider runs, which logs the message and
 * reports success — right for development and for tests, and deliberately loud
 * enough that nobody mistakes it for a real send.
 *
 * A production deployment that forgets to configure a provider gets a refusal
 * rather than a silent no-op, because "the receipts all said Sent" is a worse
 * failure than "the button raised an error on day one".
 */

let email: EmailProvider | undefined
let sms: SmsProvider | undefined

export function emailProvider(): EmailProvider {
  email ??= buildEmailProvider()
  return email
}

export function smsProvider(): SmsProvider {
  sms ??= buildSmsProvider()
  return sms
}

/** Tests inject a fake and put the real one back afterwards. */
export function setProvidersForTesting(providers: {
  email?: EmailProvider
  sms?: SmsProvider
}): void {
  if (providers.email) email = providers.email
  if (providers.sms) sms = providers.sms
}

export function resetProviders(): void {
  email = undefined
  sms = undefined
}

function buildEmailProvider(): EmailProvider {
  const config = env()
  if (config.EMAIL_PROVIDER_URL) {
    return new HttpEmailProvider({
      name: config.EMAIL_PROVIDER_NAME,
      url: config.EMAIL_PROVIDER_URL,
      token: config.EMAIL_PROVIDER_TOKEN,
      from: config.EMAIL_FROM,
    })
  }
  assertConsoleIsAcceptable(config.NODE_ENV, 'EMAIL_PROVIDER_URL')
  return new ConsoleEmailProvider()
}

function buildSmsProvider(): SmsProvider {
  const config = env()
  if (config.SMS_PROVIDER_URL) {
    return new HttpSmsProvider({
      name: config.SMS_PROVIDER_NAME,
      url: config.SMS_PROVIDER_URL,
      token: config.SMS_PROVIDER_TOKEN,
      from: config.SMS_FROM,
    })
  }
  assertConsoleIsAcceptable(config.NODE_ENV, 'SMS_PROVIDER_URL')
  return new ConsoleSmsProvider()
}

function assertConsoleIsAcceptable(nodeEnv: string, key: string): void {
  if (nodeEnv === 'production') {
    throw new Error(
      `${key} is not configured. Refusing to pretend a message was delivered in production.`,
    )
  }
}
