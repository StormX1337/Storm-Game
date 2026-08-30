'use client';

import { ShieldAlert } from 'lucide-react';
import { Card } from '@storm/ui';
import { useAuth } from '@/lib/auth-context';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isAdmin, loading } = useAuth();

  if (loading) return null;

  // The API enforces this too; the guard here just avoids rendering an admin
  // shell that would fail every request inside it.
  if (!isAdmin) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <ShieldAlert className="h-5 w-5 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold">Administrator access required</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your account does not have permission to view the administration area.
        </p>
      </Card>
    );
  }

  return <div className="mx-auto max-w-7xl animate-fade-in">{children}</div>;
}
