import type { AdminOverviewDto } from '@storm-bet/types';
import { hasPermission, Permission } from '@storm-bet/types';
import { Card, StatCard } from '@storm-bet/ui';
import { CalendarDays, Coins, Radio, Receipt, Users } from 'lucide-react';
import type { Metadata } from 'next';
import { ProviderCard, SystemHealthCard } from '@/components/admin/health';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatMoney } from '@/lib/format';
import { getSessionUser, serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Übersicht' };

export default async function AdminOverviewPage() {
  const user = await getSessionUser();
  if (!user || !hasPermission(user.role, Permission.SYSTEM_READ)) {
    return (
      <>
        <PageHeader title="Administration" description="Wähle einen Bereich in der Navigation." />
        <Card className="p-6 text-sm text-fg-muted">
          Deine Rolle hat Zugriff auf die links aufgeführten Bereiche.
        </Card>
      </>
    );
  }
  const o = await serverApi<AdminOverviewDto>('/admin/overview');
  return (
    <>
      <PageHeader
        title="Übersicht"
        description="Kennzahlen der letzten 24 Stunden und Systemzustand."
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Nutzer"
          value={o.users.total}
          hint={`${o.users.newToday} neu · ${o.users.locked} gesperrt`}
          icon={<Users />}
        />
        <StatCard
          label="Live-Events"
          value={o.events.live}
          hint={`${o.events.upcoming} geplant`}
          icon={<Radio />}
          tone="down"
        />
        <StatCard
          label="Offene Abrechnung"
          value={o.events.awaitingSettlement}
          hint="Beendete, nicht abgerechnete Events"
          icon={<CalendarDays />}
        />
        <StatCard
          label="Offene Wetten"
          value={o.bets.pending}
          hint={`${o.bets.placedToday} heute platziert`}
          icon={<Receipt />}
          tone="accent"
        />
        <StatCard
          label="Einsätze (24 h)"
          value={formatMoney(o.bets.stakedToday, { unit: false })}
          hint={`${o.transactions.today} Buchungen`}
          icon={<Coins />}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SystemHealthCard health={o.system} />
        <div className="space-y-3">
          {o.providers.map((p) => (
            <ProviderCard key={p.key} provider={p} />
          ))}
        </div>
      </div>
    </>
  );
}
