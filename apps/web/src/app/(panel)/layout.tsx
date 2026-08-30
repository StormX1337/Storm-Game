'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/panel/sidebar';
import { Topbar } from '@/components/panel/topbar';
import { AccountSocketProvider } from '@/hooks/use-account-socket';
import { useRequireAuth } from '@/lib/auth-context';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useRequireAuth();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // useRequireAuth is already redirecting; render nothing rather than flashing
  // an empty shell behind the navigation.
  if (!user) return null;

  return (
    <AccountSocketProvider enabled>
      <div className="flex min-h-screen">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenSidebar={() => setSidebarOpen(true)} />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </AccountSocketProvider>
  );
}
