import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/providers';
import { getSessionUser } from '@/lib/server-api';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'STORM BET – Sportwetten Demo', template: '%s · STORM BET' },
  description:
    'STORM BET ist eine Sportwetten-Plattform im Demo-Modus: simulierte Quoten, Demo-Guthaben, kein Echtgeld.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#07080a',
  colorScheme: 'dark',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <html lang="de" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh overflow-x-clip">
        <Providers user={user}>{children}</Providers>
      </body>
    </html>
  );
}
