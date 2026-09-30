import type { BetDto } from '@storm-bet/types';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@storm-bet/ui';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime, formatMoney, formatOdds } from '@/lib/format';
import {
  BET_STATUS_LABELS,
  BET_TYPE_LABELS,
  betStatusVariant,
  EVENT_STATUS_LABELS,
} from '@/lib/labels';
import { serverApi, ServerApiError } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Wettdetails') };
}

const LEG_RESULT = {
  PENDING: 'Offen',
  WON: 'Gewonnen',
  LOST: 'Verloren',
  VOID: 'Storniert (1,00)',
} as const;

export default async function BetDetailPage({ params }: { params: Promise<{ betId: string }> }) {
  const t = await getT();
  const { betId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(betId)) notFound();
  let bet: BetDto;
  try {
    bet = await serverApi<BetDto>(`/bets/${betId}`);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 404) notFound();
    throw error;
  }
  return (
    <>
      <Link
        href="/dashboard/bets"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> {t('Meine Wetten')}
      </Link>
      <PageHeader
        title={`${t(BET_TYPE_LABELS[bet.type])} ${bet.reference}`}
        description={t('Platziert am {0}{1}', [
          formatDateTime(bet.placedAt),
          bet.settledAt ? t(' · abgerechnet am {0}', [formatDateTime(bet.settledAt)]) : '',
        ])}
        actions={
          <Badge variant={betStatusVariant(bet.status)}>{t(BET_STATUS_LABELS[bet.status])}</Badge>
        }
      />
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          [t('Einsatz'), formatMoney(bet.stake)],
          [bet.system ? t('Ø Quote pro Wette') : t('Gesamtquote'), formatOdds(bet.totalOdds)],
          [t('Möglicher Gewinn'), formatMoney(bet.potentialReturn)],
          [t('Auszahlung'), bet.payout == null ? '—' : formatMoney(bet.payout)],
        ].map(([label, value]) => (
          <Card key={label} className="p-4">
            <p className="text-xs text-fg-muted">{t(label)}</p>
            <p className="tabular mt-1 text-lg font-semibold">{value}</p>
          </Card>
        ))}
      </div>
      {bet.settlementNote ? (
        <p className="text-sm text-fg-muted">
          {t('Hinweis:')} {t(bet.settlementNote)}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('Auswahlen & Quoten-Snapshot')}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <thead>
              <tr>
                <Th>{t('Auswahl')}</Th>
                <Th>{t('Event')}</Th>
                <Th className="text-right">{t('Quote')}</Th>
                <Th>{t('Snapshot bei Annahme')}</Th>
                <Th>{t('Ergebnis')}</Th>
              </tr>
            </thead>
            <tbody>
              {bet.selections.map((leg) => (
                <tr key={leg.id}>
                  <Td>
                    <p className="font-medium">{t(leg.selectionName)}</p>
                    <p className="text-xs text-fg-muted">{t(leg.marketName)}</p>
                  </Td>
                  <Td>
                    <Link href={`/events/${leg.eventId}`} className="hover:text-accent">
                      {leg.eventName}
                    </Link>
                    <p className="text-xs text-fg-subtle">{formatDateTime(leg.startTime)}</p>
                  </Td>
                  <Td className="tabular text-right font-semibold">{formatOdds(leg.odds)}</Td>
                  <Td className="text-xs text-fg-muted">
                    {leg.snapshot ? (
                      <>
                        {t('Quote')} {formatOdds(leg.snapshot.odds)} (v{leg.snapshot.oddsVersion}) ·{' '}
                        {t(EVENT_STATUS_LABELS[leg.snapshot.eventStatus])}
                        {leg.snapshot.score
                          ? ` · ${leg.snapshot.score.home}:${leg.snapshot.score.away}`
                          : ''}
                        <br />
                        {formatDateTime(leg.snapshot.capturedAt)} {t('· Quelle:')}{' '}
                        {leg.snapshot.source}
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td>{LEG_RESULT[leg.result]}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
