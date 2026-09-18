import { NextResponse, type NextRequest } from 'next/server'
import { completeConnect } from '@/server/services/integration.service'
import { isAppError } from '@/lib/errors'

/**
 * Where Intuit sends the operator back (docs/08 §3).
 *
 * Deliberately **not** a server action: this is a top-level browser navigation
 * from another origin, and it carries an authorization code in the query
 * string. Three things it is careful about:
 *
 *  - The `state` identifies the organization and proves the callback answers a
 *    request we made. It is compared in constant time and consumed once.
 *  - The code is exchanged server-side and never reaches the browser.
 *  - The redirect back to Settings carries a short outcome, never a token, a
 *    code or a realm.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams
  const settings = new URL('/settings/integrations/quickbooks', request.nextUrl.origin)

  // The operator pressed Cancel on Intuit's consent screen.
  const error = params.get('error')
  if (error) {
    settings.searchParams.set('connected', 'cancelled')
    return NextResponse.redirect(settings)
  }

  const state = params.get('state')
  const code = params.get('code')
  const realmId = params.get('realmId')

  if (!state || !code || !realmId) {
    settings.searchParams.set('connected', 'incomplete')
    return NextResponse.redirect(settings)
  }

  try {
    const result = await completeConnect({ state, code, realmId })
    settings.searchParams.set('connected', 'yes')
    settings.searchParams.set('company', result.companyName)
    return NextResponse.redirect(settings)
  } catch (cause) {
    // Intuit's own words are useful to us but must not be reflected into a URL.
    settings.searchParams.set(
      'connected',
      isAppError(cause) ? 'refused' : 'failed',
    )
    return NextResponse.redirect(settings)
  }
}
