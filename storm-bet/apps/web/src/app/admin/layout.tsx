import { isStaff } from '@storm-bet/types';
import { Badge } from '@storm-bet/ui';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { AdminNav } from '@/components/admin/nav';
import { Header } from '@/components/shell/header';
import { ROLE_LABELS } from '@/lib/labels';
import { getSessionUser } from '@/lib/server-api';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin · STORM BET' },
};
export const dynamic = 'force-dynamic';

/**
 * Staff area. The layout hides it from players, but every action and every
 * read is authorised again by the API — this check is only for navigation.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/admin');
  if (!isStaff(user.role)) notFound();
  return (
    <>
      <Header />
      <div className="mx-auto max-w-[1500px] px-4 py-6 lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8 lg:px-6">
        <aside className="mb-5 space-y-4 lg:mb-0">
          <div className="lg:sticky lg:top-[5rem] lg:space-y-4">
            <div className="hidden rounded-lg border border-border bg-surface p-3 lg:block">
              <p className="text-xs text-fg-subtle">Angemeldet als</p>
              <p className="truncate text-sm font-medium">{user.displayName}</p>
              <Badge variant="accent" className="mt-1.5">
                {ROLE_LABELS[user.role]}
              </Badge>
            </div>
            <AdminNav role={user.role} />
          </div>
        </aside>
        <main className="min-w-0 space-y-6">{children}</main>
      </div>
    </>
  );
}
