import type { Metadata, Viewport } from 'next';

import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'Football Value Scanner',
  description:
    'Statistical value analysis for football betting markets: model probabilities, fair odds, expected value, confidence and risk.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1020',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
