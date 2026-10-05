import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { DEMO_MODE_LABEL } from '@/components/casino/labels';
import { DemoBanner } from '@/components/shell/demo-banner';
import { Footer } from '@/components/shell/footer';
import { Header } from '@/components/shell/header';
import { MobileTabBar } from '@/components/shell/mobile-tab-bar';
import { getSessionUser } from '@/lib/server-api';

export const metadata: Metadata = {
  title: { default: 'Casino', template: '%s · Casino · STORM BET' },
};
export const dynamic = 'force-dynamic';

/** Casino shell: login required (18+ verified at registration), play money only. */
export default async function CasinoLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login?next=/casino');
  return (
    <>
      <DemoBanner />
      <Header />
      <div className="border-b border-accent/20 bg-accent-soft/40">
        <p
          className="mx-auto max-w-[1440px] px-4 py-1.5 text-center text-xs font-semibold tracking-wide text-accent-strong lg:px-6"
          data-testid="casino-demo-mode"
        >
          {DEMO_MODE_LABEL}
        </p>
      </div>
      <main className="mx-auto max-w-[1440px] space-y-6 px-4 py-6 lg:px-6">{children}</main>
      <Footer />
      <MobileTabBar />
    </>
  );
}
