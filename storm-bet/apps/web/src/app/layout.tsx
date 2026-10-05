import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers';
import { getLocale, getT } from '@/i18n/server';
import { getSessionUser } from '@/lib/server-api';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: { default: t('STORM BET – Sportwetten Demo'), template: '%s · STORM BET' },
    description: t(
      'STORM BET ist eine Sportwetten-Plattform im Demo-Modus: Demo-Guthaben, kein Echtgeld.',
    ),
    ...BASE_METADATA,
  };
}

const BASE_METADATA: Metadata = {
  robots: { index: false, follow: false },
  applicationName: 'STORM BET',
  // iPhone: "Zum Home-Bildschirm" opens it like an app (also without HTTPS).
  appleWebApp: { capable: true, title: 'STORM BET', statusBarStyle: 'black-translucent' },
  icons: { apple: '/icons/apple-touch-icon.png' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#07080c',
  colorScheme: 'dark',
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, locale] = await Promise.all([getSessionUser(), getLocale()]);
  return (
    <html lang={locale} className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh overflow-x-clip">
        <Providers user={user} locale={locale}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
