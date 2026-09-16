import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { LoginForm } from '@/components/auth/LoginForm'
import { getAuthContext } from '@/server/auth/context'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  if (await getAuthContext()) redirect('/')
  const { next } = await searchParams

  return (
    <Card className="p-5">
      <h1 className="text-xl font-bold text-ink">Sign in</h1>
      <p className="mt-1 mb-5 text-sm text-ink-muted">Welcome back. Let&apos;s get rolling.</p>

      <LoginForm next={next} />

      <p className="mt-5 text-center text-sm text-ink-muted">
        New to SnackLoad?{' '}
        <Link href="/register" className="font-semibold text-navy-600 hover:underline">
          Start your company
        </Link>
      </p>
    </Card>
  )
}
