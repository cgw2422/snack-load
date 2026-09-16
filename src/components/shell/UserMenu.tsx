'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { LogOut, User as UserIcon } from 'lucide-react'
import { logoutAction } from '@/app/(auth)/actions'

export function UserMenu({
  initials,
  name,
  roleName,
}: {
  initials: string
  name: string
  roleName: string
}) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex size-touch items-center justify-center rounded-full bg-white/15 text-sm font-bold text-white transition-colors hover:bg-white/25 md:bg-navy-800"
      >
        {initials}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.5rem)] w-56 overflow-hidden rounded-xl border border-line bg-surface-raised text-ink shadow-xl"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-xs text-ink-muted">{roleName}</p>
          </div>

          <Link
            href="/settings/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-touch items-center gap-2.5 px-4 text-sm font-medium hover:bg-surface-sunken"
          >
            <UserIcon className="size-4" aria-hidden="true" />
            Your profile
          </Link>

          <form action={logoutAction}>
            <button
              type="submit"
              role="menuitem"
              className="flex min-h-touch w-full items-center gap-2.5 border-t border-line px-4 text-left text-sm font-medium text-stop-600 hover:bg-stop-500/5"
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  )
}
