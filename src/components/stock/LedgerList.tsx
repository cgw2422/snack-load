import {
  ArrowLeftRight, Ban, ClipboardCheck, PackageMinus, PackagePlus, ShoppingCart, Truck, Undo2,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideProps } from 'lucide-react'
import { formatQuantity } from '@/server/domain/uom'
import { relativeTime } from '@/lib/dates'
import type { LedgerEntry } from '@/server/services/receiving.service'

/**
 * Movement history. Every number in this app is explainable by a row here, which
 * is the whole reason the ledger is append-only (docs/02 §L1).
 */
const LABELS: Record<string, { label: string; icon: ComponentType<LucideProps> }> = {
  SUPPLIER_RECEIPT: { label: 'Received', icon: PackagePlus },
  TRUCK_LOAD: { label: 'Loaded', icon: Truck },
  TRUCK_UNLOAD: { label: 'Unloaded', icon: PackageMinus },
  TRANSFER: { label: 'Transferred', icon: ArrowLeftRight },
  SALE: { label: 'Sold', icon: ShoppingCart },
  CUSTOMER_RETURN: { label: 'Returned', icon: Undo2 },
  DAMAGE: { label: 'Damaged', icon: Ban },
  EXPIRED: { label: 'Expired', icon: Ban },
  MISSING: { label: 'Missing', icon: Ban },
  SAMPLE: { label: 'Sample', icon: Ban },
  CORRECTION: { label: 'Correction', icon: ClipboardCheck },
  COUNT_ADJUSTMENT: { label: 'Counted', icon: ClipboardCheck },
  REVERSAL: { label: 'Reversed', icon: Undo2 },
}

export function LedgerList({
  entries,
  showProduct = true,
}: {
  entries: LedgerEntry[]
  showProduct?: boolean
}) {
  if (entries.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-ink-muted">No movements yet.</p>
  }

  return (
    <ul className="divide-y divide-line">
      {entries.map((entry) => {
        const meta = LABELS[entry.type] ?? { label: entry.type, icon: ClipboardCheck }
        const Icon = meta.icon
        const incoming = entry.quantityDelta > 0

        return (
          <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                incoming
                  ? 'bg-cash-50 text-cash-600 dark:bg-cash-700/20 dark:text-cash-100'
                  : 'bg-surface-sunken text-ink-muted'
              }`}
            >
              <Icon className="size-4" aria-hidden="true" />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">
                {showProduct ? entry.productName : meta.label}
              </span>
              <span className="block truncate text-xs text-ink-muted">
                {showProduct ? `${meta.label} · ` : ''}
                {entry.locationName}
                {entry.actorName ? ` · ${entry.actorName}` : ''}
                {' · '}
                {relativeTime(new Date(entry.occurredAt))}
              </span>
              {entry.notes ? (
                <span className="block truncate text-xs text-ink-subtle">{entry.notes}</span>
              ) : null}
            </span>

            <span className="shrink-0 text-right">
              <span
                className={`tnum block text-sm font-bold ${
                  incoming ? 'text-cash-600' : 'text-ink'
                }`}
              >
                {incoming ? '+' : '−'}
                {formatQuantity(Math.abs(entry.quantityDelta), entry.unitsPerCase)}
              </span>
              <span className="tnum block text-xs text-ink-subtle">
                {formatQuantity(entry.balanceAfter, entry.unitsPerCase)} left
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
