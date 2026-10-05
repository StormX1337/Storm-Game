import type { AdminEventListItemDto, Paginated } from '@storm-bet/types';
import { EVENT_STATUSES, SPORT_KEYS } from '@storm-bet/types';
import { Badge, Button, Card, EmptyState, Input, NativeSelect, Table, Td, Th } from '@storm-bet/ui';
import { CalendarDays, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterBar, NextPage, query } from '@/components/admin/ui';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { EVENT_STATUS_LABELS, SPORT_LABELS } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Events' };

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = await serverApi<Paginated<AdminEventListItemDto>>(
    `/admin/events${query(params, ['q', 'sport', 'status', 'provider', 'awaitingSettlement', 'cursor'])}`,
  );
  return (
    <>
      <PageHeader
        title="Events & Märkte"
        description="Events aus dem Quoten-Feed und manuell angelegte Events."
        actions={
          <Button asChild>
            <Link href="/admin/events/new">
              <Plus /> Event anlegen
            </Link>
          </Button>
        }
      />
      <FilterBar>
        <Input
          name="q"
          defaultValue={params.q}
          placeholder="Team, Liga oder ID"
          className="w-56"
          aria-label="Suche"
        />
        <NativeSelect
          name="sport"
          defaultValue={params.sport ?? ''}
          className="w-36"
          aria-label="Sportart"
        >
          <option value="">Alle Sportarten</option>
          {SPORT_KEYS.map((s) => (
            <option key={s} value={s}>
              {SPORT_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="status"
          defaultValue={params.status ?? ''}
          className="w-36"
          aria-label="Status"
        >
          <option value="">Alle Status</option>
          {EVENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {EVENT_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          name="provider"
          defaultValue={params.provider ?? ''}
          className="w-36"
          aria-label="Quelle"
        >
          <option value="">Alle Quellen</option>
          <option value="mock">Feed (mock)</option>
          <option value="manual">Manuell</option>
        </NativeSelect>
        <NativeSelect
          name="awaitingSettlement"
          defaultValue={params.awaitingSettlement ?? ''}
          className="w-48"
          aria-label="Abrechnung"
        >
          <option value="">Abrechnung: alle</option>
          <option value="true">Nur offene Abrechnung</option>
        </NativeSelect>
      </FilterBar>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<CalendarDays />} title="Keine Events gefunden" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Start</Th>
                <Th>Status</Th>
                <Th>Ergebnis</Th>
                <Th>Flags</Th>
                <Th>Quelle</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((e) => (
                <tr key={e.id} className="hover:bg-surface-2/50">
                  <Td>
                    <Link
                      href={`/admin/events/${e.id}`}
                      className="font-medium hover:text-accent-strong"
                    >
                      {e.home.name} – {e.away.name}
                    </Link>
                    <p className="text-xs text-fg-muted">
                      {e.sport.name} · {e.league.name}
                    </p>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDateTime(e.startTime)}
                  </Td>
                  <Td>
                    <Badge
                      variant={
                        e.rawStatus === 'LIVE'
                          ? 'live'
                          : e.rawStatus === 'FINISHED'
                            ? 'default'
                            : e.rawStatus === 'CANCELLED'
                              ? 'danger'
                              : 'outline'
                      }
                    >
                      {EVENT_STATUS_LABELS[e.rawStatus]}
                    </Badge>
                  </Td>
                  <Td className="tabular">{e.score ? `${e.score.home}:${e.score.away}` : '—'}</Td>
                  <Td className="space-x-1 whitespace-nowrap">
                    {!e.isActive ? <Badge variant="danger">Inaktiv</Badge> : null}
                    {e.tradingSuspended ? <Badge variant="warning">Gesperrt</Badge> : null}
                    {e.settledAt ? (
                      <Badge variant="success">Abgerechnet</Badge>
                    ) : e.resultConfirmedAt ? (
                      <Badge variant="accent">Ergebnis</Badge>
                    ) : null}
                  </Td>
                  <Td className="font-mono text-xs text-fg-muted">{e.provider}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NextPage page={page} basePath="/admin/events" params={params} />
    </>
  );
}
