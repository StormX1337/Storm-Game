import type { AccountSummaryDto, BetDto, Paginated } from '@storm-bet/types';
import { Button, Card, EmptyState, StatCard } from '@storm-bet/ui';
import { CheckCheck, Coins, Hourglass, Receipt, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { BetCard } from '@/components/dashboard/bet-card';
import { VerifyNotice } from '@/components/dashboard/verify-notice';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { formatMoney } from '@/lib/format';
import { getSessionUser, serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="dashboard-cards">
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
            <Link href="/dashboard/bets" className="text-sm text-accent hover:underline">
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
    </>
  );
}
