import { describe, expect, it } from 'vitest'
import { Prisma } from '@/generated/prisma/client'
import { classifyUnexpected } from '@/server/integrations/quickbooks/sync/worker'
import { classifyFault } from '@/server/integrations/quickbooks/client'
import { conflict } from '@/lib/errors'
import { QuickBooksError } from '@/server/integrations/quickbooks/types'

/**
 * What an operator is shown when something goes wrong (docs/08 §14).
 *
 * Sync issues are read by somebody who runs a distribution business, not by
 * whoever wrote this. A stack trace, a compiled chunk path or a Prisma query
 * dump tells them nothing they can act on and leaks the inside of the server
 * into a settings screen.
 */
describe('unexpected sync failures', () => {
  it('passes a domain error through, because it is already a sentence', () => {
    const classified = classifyUnexpected(conflict('That period has already been posted.'))
    expect(classified.message).toBe('That period has already been posted.')
    expect(classified.category).toBe('VALIDATION')
  })

  it('explains a mapping collision instead of showing the constraint', () => {
    const collision = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the constraint: `external_mapping_organization_id_provider_entity_type_extern_key`',
      { code: 'P2002', clientVersion: '7.10.0' },
    )
    const classified = classifyUnexpected(collision)

    expect(classified.category).toBe('MAPPING')
    expect(classified.message).toMatch(/already mapped to another SnackLoad document/i)
    expect(classified.message).toMatch(/different QuickBooks company/i)
    expect(classified.message).not.toMatch(/constraint|prisma/i)
  })

  it('hides everything else behind a sentence somebody can act on', () => {
    const internal = new Error(
      'Invalid `prisma.externalMapping.update()` invocation in /app/.next/server/chunks/x.js:2013:34',
    )
    const classified = classifyUnexpected(internal)

    expect(classified.message).toBe(
      'Something went wrong preparing this document for QuickBooks. The details are in the server log.',
    )
    expect(classified.message).not.toMatch(/prisma|\.next|invocation/i)
  })

  it('leaves a QuickBooks error alone — those are Intuit’s own words', () => {
    const fault = classifyFault(
      400,
      JSON.stringify({
        Fault: {
          Error: [{ code: '6140', Message: 'Duplicate Document Number Error', Detail: 'Duplicate Document Number Error: You must specify a different number.' }],
          type: 'ValidationFault',
        },
      }),
    )
    expect(fault).toBeInstanceOf(QuickBooksError)
    expect(fault.message).toMatch(/different number/i)
    expect(fault.options.code).toBe('6140')
  })
})
