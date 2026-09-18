import { execSync } from 'node:child_process'
import type { NextConfig } from 'next'

/**
 * The identity of this build, and therefore of the service worker's caches.
 *
 * A deploy has to produce a new value or a runner keeps last week's JavaScript
 * for as long as their phone stays installed. Git's commit is the honest answer
 * when there is one; the platform's own variable is used first because a
 * container built from a tarball has no `.git`.
 */
function resolveBuildId(): string {
  const supplied =
    process.env.BUILD_ID ||
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA
  if (supplied) return supplied.slice(0, 12)

  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No commit to name it after. A timestamp is still unique per build, which
    // is the only property the cache names actually depend on.
    return `t${Date.now().toString(36)}`
  }
}

const buildId = resolveBuildId()

const nextConfig: NextConfig = {
  // The default bottom-left badge sits exactly on top of the Home tab in the
  // mobile bottom nav, which makes the primary UI awkward to develop against.
  devIndicators: { position: 'bottom-right' },

  serverExternalPackages: ['@prisma/adapter-pg'],

  generateBuildId: async () => buildId,

  env: {
    /** Read by the service-worker registration to version its caches. */
    NEXT_PUBLIC_BUILD_ID: buildId,
  },

  experimental: {
    // Connectivity detection plus automatic retry of navigations, prefetches
    // and Server Actions that never reached the origin. Safe alongside the
    // mutation queue: every financial write carries an idempotency key, so a
    // framework retry of one replays rather than posting twice (docs/02 §I1).
    useOffline: true,
  },

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
      {
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          // The worker is the one file that must never be served stale: it is
          // what decides how stale everything else may be.
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          // Served from /public, so it already controls the whole origin; the
          // header is here so that stays true if the asset path ever moves.
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ]
  },
}

export default nextConfig
