import type { AdminBetDetailDto } from '@storm-bet/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@storm-bet/ui';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BetActions } from '@/components/admin/bet-actions';
import { KeyValue } from '@/components/admin/ui';
import { BetCard } from '@/components/dashboard/bet-card';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney } from '@/lib/format';
import { BET_STATUS_LABELS, betStatusVariant, TRANSACTION_LABELS } from '@/lib/labels';
import { serverApi, ServerApiError } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Wette' };

export default async function AdminBetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let bet: AdminBetDetailDto;
  try {
    bet = await serverApi<AdminBetDetailDto>(`/admin/bets/${id}`);
  } catch (e) {
    if (e instanceof ServerApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <Link
        href="/admin/bets"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Wetten
      </Link>
      <PageHeader
        title={`Wette ${bet.reference}`}
        description={
          <>
            von{' '}
            <Link href={`/admin/users/${bet.user.id}`} className="text-accent hover:underline">
              {bet.user.email}
            </Link>
          </>
        }
        actions={
          <Badge variant={betStatusVariant(bet.status)}>{BET_STATUS_LABELS[bet.status]}</Badge>
        }
      />
      <BetActions bet={bet} />
      <div className="grid gap-4 xl:grid-cols-2">
        <BetCard bet={bet} />
        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <KeyValue
              items={[
                [
                  'Slip',
                  <span key="slip" className="font-mono text-xs">
                    {bet.slipId}
                  </span>,
                ],
                [
                  'Quotenänderung',
                  bet.oddsChangePolicy === 'ACCEPT_HIGHER' ? 'Höhere akzeptieren' : 'Ablehnen',
                ],
                ['Platziert', formatDateTime(bet.placedAt)],
                ['Abgerechnet', bet.settledAt ? formatDateTime(bet.settledAt) : '—'],
                ['Hinweis', bet.settlementNote ?? '—'],
              ]}
            />
          </CardContent>
        </Card>
      </div>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Buchungen</CardTitle>
        </CardHeader>
        <Table>
          <thead>
            <tr>
              <Th>Zeit</Th>
              <Th>Typ</Th>
              <Th className="text-right">Saldo Δ</Th>
              <Th className="text-right">Reserviert Δ</Th>
              <Th className="text-right">Saldo danach</Th>
            </tr>
          </thead>
          <tbody>
            {bet.transactions.map((t) => (
              <tr key={t.id}>
                <Td className="text-xs text-fg-muted">{formatDateTime(t.createdAt)}</Td>
                <Td>{TRANSACTION_LABELS[t.type]}</Td>
                <Td className="tabular text-right">
                  {formatMoney(t.amount, { sign: true, unit: false })}
                </Td>
                <Td className="tabular text-right">
                  {formatMoney(t.reservedDelta, { sign: true, unit: false })}
                </Td>
                <Td className="tabular text-right">
                  {formatMoney(t.balanceAfter, { unit: false })}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Audit-Trail</CardTitle>
        </CardHeader>
        <Table>
          <tbody>
            {bet.audit.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap text-xs text-fg-muted">
                  {formatDateTime(a.createdAt)}
                </Td>
                <Td className="font-mono text-xs">{a.action}</Td>
                <Td className="text-xs">{a.actorEmail ?? (a.actorId ? a.actorId : 'System')}</Td>
                <Td className="max-w-md truncate font-mono text-[11px] text-fg-subtle">
                  {JSON.stringify(a.metadata)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
