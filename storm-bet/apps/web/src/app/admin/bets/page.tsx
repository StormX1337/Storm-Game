import type { AdminBetDto, Paginated } from '@storm-bet/types';
import { BET_STATUSES } from '@storm-bet/types';
import { Badge, Card, EmptyState, Input, NativeSelect, Table, Td, Th } from '@storm-bet/ui';
import { Receipt } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterBar, NextPage, query } from '@/components/admin/ui';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney, formatOdds } from '@/lib/format';
import { BET_STATUS_LABELS, BET_TYPE_LABELS, betStatusVariant } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Wetten' };

export default async function AdminBetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = await serverApi<Paginated<AdminBetDto>>(
    `/admin/bets${query(params, ['q', 'status', 'userId', 'eventId', 'cursor'])}`,
  );
  return (
    <>
      <PageHeader title="Wetten" description="Alle Wetten mit Status und Abrechnung." />
      <FilterBar>
        <Input
          name="q"
          defaultValue={params.q}
          placeholder="Wettnummer oder E-Mail"
          className="w-56"
          aria-label="Suche"
        />
        <NativeSelect
          name="status"
          defaultValue={params.status ?? ''}
          className="w-40"
          aria-label="Status"
        >
          <option value="">Alle Status</option>
          {BET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {BET_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
        {params.userId ? <input type="hidden" name="userId" value={params.userId} /> : null}
        {params.eventId ? <input type="hidden" name="eventId" value={params.eventId} /> : null}
      </FilterBar>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<Receipt />} title="Keine Wetten gefunden" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Wette</Th>
                <Th>Nutzer</Th>
                <Th>Auswahlen</Th>
                <Th className="text-right">Einsatz</Th>
                <Th className="text-right">Quote</Th>
                <Th className="text-right">Auszahlung</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((b) => (
                <tr key={b.id} className="hover:bg-surface-2/50">
                  <Td>
                    <Link
                      href={`/admin/bets/${b.id}`}
                      className="font-mono text-xs hover:text-accent"
                    >
                      {b.reference}
                    </Link>
                    <p className="text-xs text-fg-subtle">
                      {BET_TYPE_LABELS[b.type]} · {formatDateTime(b.placedAt)}
                    </p>
                  </Td>
                  <Td className="text-xs">
                    <Link href={`/admin/users/${b.user.id}`} className="hover:text-accent">
                      {b.user.email}
                    </Link>
                  </Td>
                  <Td className="max-w-72 truncate text-xs text-fg-muted">
                    {b.selections.map((s) => s.selectionName).join(' · ')}
                  </Td>
                  <Td className="tabular text-right">{formatMoney(b.stake, { unit: false })}</Td>
                  <Td className="tabular text-right">{formatOdds(b.totalOdds)}</Td>
                  <Td className="tabular text-right">
                    {b.payout == null ? '—' : formatMoney(b.payout, { unit: false })}
                  </Td>
                  <Td>
                    <Badge variant={betStatusVariant(b.status)}>
                      {BET_STATUS_LABELS[b.status]}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NextPage page={page} basePath="/admin/bets" params={params} />
    </>
  );
}
