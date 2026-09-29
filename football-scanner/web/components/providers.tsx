'use client';

import { ThemeProvider } from 'next-themes';
import { SWRConfig } from 'swr';

import { fetcher } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <SWRConfig
        value={{
          fetcher,
          revalidateOnFocus: true,
          shouldRetryOnError: (err: { status?: number }) =>
            err?.status !== 401 && err?.status !== 403,
        }}
      >
        {children}
      </SWRConfig>
    </ThemeProvider>
  );
}
