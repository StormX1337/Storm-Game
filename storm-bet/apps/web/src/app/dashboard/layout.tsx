import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DashboardNav } from '@/components/dashboard/nav';
import { DemoBanner } from '@/components/shell/demo-banner';
import { Footer } from '@/components/shell/footer';
import { Header } from '@/components/shell/header';
import { getSessionUser } from '@/lib/server-api';

export const metadata: Metadata = {
  title: { default: 'Mein Konto', template: '%s · Mein Konto · STORM BET' },
};
export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/dashboard');
  return (
    <>
      <DemoBanner />
      <Header />
      <div className="mx-auto max-w-6xl px-4 py-6 lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-8 lg:px-6 lg:py-8">
        <aside className="mb-5 lg:mb-0">
          <div className="lg:sticky lg:top-[4.5rem]">
            <DashboardNav />
          </div>
        </aside>
        <main className="min-w-0 space-y-6">{children}</main>
      </div>
      <Footer />
    </>
  );
}
