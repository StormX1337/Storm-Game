import type { AccountSummaryDto, BetDto, Paginated } from '@storm-bet/types';
import { Button, Card, EmptyState, StatCard } from '@storm-bet/ui';
import {
  CheckCheck,
  Coins,
  Dices,
  Gift,
  HeartHandshake,
  Hourglass,
  Layers,
  Receipt,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { BetCard } from '@/components/dashboard/bet-card';
import { VerifyNotice } from '@/components/dashboard/verify-notice';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { formatMoney } from '@/lib/format';
import { getSessionUser, serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

/** Everything beyond the sportsbook tabs – the bottom bar's "Konto" leads here. */
const MORE = [
  { href: '/casino', label: 'Casino', icon: Dices },
  { href: '/bet-builder', label: 'Bet Builder', icon: Layers },
  { href: '/promotions', label: 'Aktionen', icon: Gift },
  { href: '/feed', label: 'Tipp-Feed', icon: Users },
  { href: '/leaderboard', label: 'Rangliste', icon: Trophy },
  { href: '/responsible-gaming', label: 'Spielerschutz', icon: HeartHandshake },
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const t = await getT();
  const { welcome } = await searchParams;
  const [user, summary, recent] = await Promise.all([
    getSessionUser(),
    serverApi<AccountSummaryDto>('/account/summary'),
    serverApi<Paginated<BetDto>>('/bets?limit=4'),
  ]);
  return (
    <>
      <PageHeader
        title={welcome ? t('Willkommen, {0}!', [user?.displayName ?? '']) : t('Übersicht')}
        description={
          welcome
            ? t('Dein Konto ist eingerichtet – 1.000 € Spielgeld stehen bereit.')
            : t('Dein Demo-Konto auf einen Blick.')
        }
        actions={
          <Button asChild>
            <Link href="/live">{t('Jetzt wetten')}</Link>
          </Button>
        }
      />
      {user && !user.emailVerified ? <VerifyNotice /> : null}
      <div
        className="grid grid-cols-2 gap-3 xl:grid-cols-5 [&>*:first-child]:col-span-2 xl:[&>*:first-child]:col-span-1"
        data-testid="dashboard-cards"
      >
        <StatCard
          label={t('Demo Balance')}
          value={formatMoney(summary.wallet.available, { unit: false })}
          hint={`${formatMoney(summary.wallet.reserved)} reserviert`}
          icon={<Wallet />}
          tone="accent"
        />
        <StatCard label={t('Offene Wetten')} value={summary.openBets} icon={<Hourglass />} />
        <StatCard
          label={t('Abgerechnete Wetten')}
          value={summary.settledBets}
          hint={t('{0} gewonnen · {1} verloren', [summary.wonBets, summary.lostBets])}
          icon={<CheckCheck />}
        />
        <StatCard
          label={t('Einsätze gesamt')}
          value={formatMoney(summary.totalStaked, { unit: false })}
          icon={<Coins />}
        />
        <StatCard
          label={t('Auszahlungen gesamt')}
          value={formatMoney(summary.totalReturns, { unit: false })}
          icon={<TrendingUp />}
          tone="up"
        />
      </div>
      <section className="space-y-3">
        <SectionTitle
          action={
            <Link href="/dashboard/bets" className="text-sm text-accent-strong hover:underline">
              {t('Alle Wetten')}
            </Link>
          }
        >
          {t('Letzte Wetten')}
        </SectionTitle>
        {recent.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Receipt />}
              title={t('Noch keine Wetten')}
              description={t(
                'Wähle eine Quote, lege deinen Einsatz im Wettschein fest und platziere deine erste Demo-Wette.',
              )}
              action={
                <Button asChild variant="secondary">
                  <Link href="/sports">{t('Events entdecken')}</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {recent.items.map((bet) => (
              <BetCard key={bet.id} bet={bet} href={`/dashboard/bets/${bet.id}`} />
            ))}
          </div>
        )}
      </section>
      <section className="space-y-3" aria-labelledby="more-title">
        <SectionTitle>
          <span id="more-title">{t('Mehr')}</span>
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {MORE.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition-colors hover:border-border-strong hover:bg-surface-2"
              data-testid="account-more"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-muted transition-colors group-hover:text-accent-strong">
                <item.icon className="size-[18px]" aria-hidden="true" />
              </span>
              <span className="min-w-0 truncate text-sm font-semibold">{t(item.label)}</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
