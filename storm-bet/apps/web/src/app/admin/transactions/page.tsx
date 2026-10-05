import type { AdminTransactionDto, Paginated } from '@storm-bet/types';
import { TRANSACTION_TYPES } from '@storm-bet/types';
import { Card, EmptyState, Input, NativeSelect, Table, Td, Th } from '@storm-bet/ui';
import { ArrowLeftRight } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { FilterBar, NextPage, query } from '@/components/admin/ui';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney } from '@/lib/format';
import { TRANSACTION_LABELS } from '@/lib/labels';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Transaktionen' };

export default async function AdminTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const page = await serverApi<Paginated<AdminTransactionDto>>(
    `/admin/transactions${query(params, ['userId', 'betId', 'type', 'cursor'])}`,
  );
  return (
    <>
      <PageHeader
        title="Transaktionen"
        description="Das unveränderliche Hauptbuch aller Guthabenbewegungen."
      />
      <FilterBar>
        <Input
          name="userId"
          defaultValue={params.userId}
          placeholder="Nutzer-ID"
          className="w-72"
          aria-label="Nutzer-ID"
        />
        <Input
          name="betId"
          defaultValue={params.betId}
          placeholder="Wett-ID"
          className="w-72"
          aria-label="Wett-ID"
        />
        <NativeSelect
          name="type"
          defaultValue={params.type ?? ''}
          className="w-44"
          aria-label="Typ"
        >
          <option value="">Alle Typen</option>
          {TRANSACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRANSACTION_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
      </FilterBar>
      <Card className="overflow-hidden">
        {page.items.length === 0 ? (
          <EmptyState icon={<ArrowLeftRight />} title="Keine Transaktionen" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Zeit</Th>
                <Th>Nutzer</Th>
                <Th>Typ</Th>
                <Th>Wette</Th>
                <Th className="text-right">Saldo Δ</Th>
                <Th className="text-right">Reserviert Δ</Th>
                <Th className="text-right">Saldo / reserviert danach</Th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((t) => (
                <tr key={t.id}>
                  <Td className="whitespace-nowrap text-xs text-fg-muted">
                    {formatDateTime(t.createdAt)}
                  </Td>
                  <Td className="text-xs">
                    <Link href={`/admin/users/${t.user.id}`} className="hover:text-accent-strong">
                      {t.user.email}
                    </Link>
                  </Td>
                  <Td>{TRANSACTION_LABELS[t.type]}</Td>
                  <Td className="font-mono text-xs">
                    {t.betId ? (
                      <Link href={`/admin/bets/${t.betId}`} className="hover:text-accent-strong">
                        {t.betReference}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="tabular text-right">
                    {formatMoney(t.amount, { sign: true, unit: false })}
                  </Td>
                  <Td className="tabular text-right">
                    {formatMoney(t.reservedDelta, { sign: true, unit: false })}
                  </Td>
                  <Td className="tabular whitespace-nowrap text-right text-xs">
                    {formatMoney(t.balanceAfter, { unit: false })} /{' '}
                    {formatMoney(t.reservedAfter, { unit: false })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NextPage page={page} basePath="/admin/transactions" params={params} />
    </>
  );
}
