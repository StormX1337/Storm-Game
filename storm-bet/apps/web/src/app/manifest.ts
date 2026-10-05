import type { MetadataRoute } from 'next';

/** Installable app: home-screen icon, own window, starts on the sports page. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'STORM BET – Sportwetten Demo',
    short_name: 'STORM BET',
    description: 'Sportwetten und Casino im Demo-Modus – nur Spielgeld, kein Echtgeld.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#07080c',
    theme_color: '#07080c',
    lang: 'de',
    categories: ['sports', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Live', url: '/live' },
      { name: 'Meine Wetten', url: '/dashboard/bets' },
      { name: 'Casino', url: '/casino' },
    ],
  };
}
