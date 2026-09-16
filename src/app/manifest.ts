import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SnackLoad — Inventory. Routes. Sales.',
    short_name: 'SnackLoad',
    description:
      'Route sales and distribution management for independent snack and beverage distributors.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b2141',
    theme_color: '#0b2141',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: "Today's route", short_name: 'Route', url: '/routes' },
      { name: 'New sale', short_name: 'Sell', url: '/sell' },
      { name: 'Inventory', short_name: 'Stock', url: '/inventory' },
    ],
  }
}
