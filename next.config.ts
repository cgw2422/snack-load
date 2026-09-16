import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The default bottom-left badge sits exactly on top of the Home tab in the
  // mobile bottom nav, which makes the primary UI awkward to develop against.
  devIndicators: { position: 'bottom-right' },

  serverExternalPackages: ['@prisma/adapter-pg'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
        ],
      },
    ]
  },
}

export default nextConfig
