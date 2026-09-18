import type { ReactNode } from 'react'
import { SnackLoadWordmark } from '@/components/Brand'
import { OfflineRuntime } from '@/components/offline/OfflineRuntime'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface-sunken">
      {/* Nobody is signed in here, which is exactly when the device's cached
          tenant reads have to go. */}
      <OfflineRuntime owner={null} />
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-10">
        <header className="mb-8 flex flex-col items-center gap-3 pt-6">
          <SnackLoadWordmark showTagline />
          <p className="text-center text-sm font-medium text-ink-muted">
            Load it. Route it. Sell it.
          </p>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="pt-8 text-center text-xs text-ink-subtle">
          Built for independent snack distributors.
        </footer>
      </div>
    </div>
  )
}
