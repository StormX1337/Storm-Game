'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { ConfirmProvider, ToastProvider, TooltipProvider } from '@storm/ui';
import { AuthProvider } from '@/lib/auth-context';
import { ApiError } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Live data arrives over the websocket, so aggressive refetching
            // would mostly duplicate work already done.
            staleTime: 15_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Never retry a request the server has definitively rejected.
              if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <TooltipProvider delayDuration={250}>
              <AuthProvider>{children}</AuthProvider>
            </TooltipProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
