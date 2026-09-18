import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import type { ReactNode } from 'react'
import './globals.css'
import { startupImages } from '@/lib/splash'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'SnackLoad — Load it. Route it. Sell it.',
    template: '%s · SnackLoad',
  },
  description:
    'Inventory, routes and sales for independent snack and beverage distributors. Know what you have, what is on every truck, and what every store owes you.',
  applicationName: 'SnackLoad',
  appleWebApp: {
    capable: true,
    title: 'SnackLoad',
    statusBarStyle: 'black-translucent',
    // iOS ignores the manifest's background colour and boots a home-screen app
    // to a white flash unless it is handed a launch image that matches the
    // device exactly. One per phone, portrait only (docs/05 §2).
    startupImage: startupImages,
  },
  icons: {
    icon: [
      { url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Pinch-zoom stays available: locking it out fails WCAG 1.4.4 and makes a
  // receipt unreadable for anyone who needs to magnify it.
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a1526' },
  ],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
