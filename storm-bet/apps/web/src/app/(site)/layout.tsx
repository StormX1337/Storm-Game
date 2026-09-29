import type { SportDto } from '@storm-bet/types';
import { BetSlipPanel, MobileBetSlipBar } from '@/components/betslip/bet-slip-panel';
import { DemoBanner } from '@/components/shell/demo-banner';
import { Footer } from '@/components/shell/footer';
import { MobileTabBar } from '@/components/shell/mobile-tab-bar';
import { Header } from '@/components/shell/header';
import { Sidebar, SportTabs } from '@/components/shell/sidebar';
import { tryServerApi } from '@/lib/server-api';

/**
 * Sportsbook shell. Desktop: navigation left, content centre, bet slip right.
 * Mobile: top navigation, sport chips, and a sticky bet slip button.
 */
export default async function SiteLayout({ children }: { children: React.ReactNode }) {
  const sports = (await tryServerApi<SportDto[]>('/sports')) ?? [];
  const liveCount = sports.reduce((sum, s) => sum + s.liveCount, 0);
  return (
    <>
      <DemoBanner />
      <Header liveCount={liveCount} />
      <div className="mx-auto max-w-[1600px] px-4 py-4 lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6 lg:px-6 xl:grid-cols-[208px_minmax(0,1fr)_340px]">
        <aside className="hidden xl:block">
          <div className="sticky top-[4.5rem]">
            <Sidebar sports={sports} />
          </div>
        </aside>
        <main className="min-w-0 space-y-5 pb-28 lg:pb-8">
          <SportTabs sports={sports} />
          {children}
        </main>
        <div className="hidden lg:block">
          <BetSlipPanel />
        </div>
      </div>
      <Footer />
      <MobileTabBar />
      <MobileBetSlipBar />
    </>
  );
}
