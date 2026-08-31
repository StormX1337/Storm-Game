'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/panel/sidebar';
import { Topbar } from '@/components/panel/topbar';
import { AnnouncementBanner, MaintenanceBanner } from '@/components/panel/banners';
import { MaintenanceScreen } from '@/components/panel/maintenance-screen';
import { AccountSocketProvider } from '@/hooks/use-account-socket';
import { useRequireAuth } from '@/lib/auth-context';
import { useMaintenanceLockout } from '@/lib/panel-settings';

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useRequireAuth();
  const { locked, message } = useMaintenanceLockout();
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

  // Checked after sign-in, so the customer gets an explanation instead of the
  // panel answering 503 to everything it loads. The settings query keeps
  // polling underneath, so the panel comes back on its own.
  if (locked) return <MaintenanceScreen message={message} />;

  return (
    <AccountSocketProvider enabled>
      <div className="flex min-h-screen">
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenSidebar={() => setSidebarOpen(true)} />
          <MaintenanceBanner />
          <AnnouncementBanner />
          <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </AccountSocketProvider>
  );
}
