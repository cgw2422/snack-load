import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Card } from '@/components/ui/Card'
import { RegisterForm } from '@/components/auth/RegisterForm'
import { getAuthContext } from '@/server/auth/context'

export const metadata: Metadata = { title: 'Start your company' }

export default async function RegisterPage() {
  if (await getAuthContext()) redirect('/')

  return (
    <Card className="p-5">
      <h1 className="text-xl font-bold text-ink">Start your company</h1>
      <p className="mt-1 mb-5 text-sm text-ink-muted">
        Set up your distribution company. You can invite your team next.
      </p>

      <RegisterForm />

      <p className="mt-5 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link href="/login" className="font-semibold text-navy-600 hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  )
}
