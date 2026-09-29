import type { AdminEventDto } from '@storm-bet/types';
import { Badge, Card, CardContent } from '@storm-bet/ui';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventActions, MarketsTable, ResultForm } from '@/components/admin/event-admin';
import { KeyValue } from '@/components/admin/ui';
import { PageHeader, SectionTitle } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { EVENT_STATUS_LABELS } from '@/lib/labels';
import { serverApi, ServerApiError } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Event' };

export default async function AdminEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let event: AdminEventDto;
  try {
    event = await serverApi<AdminEventDto>(`/admin/events/${id}`);
  } catch (e) {
    if (e instanceof ServerApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <Link
        href="/admin/events"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Events
      </Link>
      <PageHeader
        title={`${event.home.name} – ${event.away.name}`}
        description={`${event.sport.name} · ${event.league.name} · ${formatDateTime(event.startTime)}`}
        actions={
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={event.rawStatus === 'LIVE' ? 'live' : 'outline'}>
              {EVENT_STATUS_LABELS[event.rawStatus]}
            </Badge>
            {!event.isActive ? <Badge variant="danger">Inaktiv</Badge> : null}
            {event.tradingSuspended ? <Badge variant="warning">Suspendiert</Badge> : null}
            {event.settledAt ? <Badge variant="success">Abgerechnet</Badge> : null}
          </div>
        }
      />
      <EventActions event={event} />
      <Card>
        <CardContent className="pt-4">
          <KeyValue
            items={[
              [
                'Quelle',
                event.provider === 'manual'
                  ? 'Manuell (Staff)'
                  : `Feed: ${event.provider} (simuliert)`,
              ],
              ['Spielstand', event.score ? `${event.score.home}:${event.score.away}` : '—'],
              [
                'Ergebnis bestätigt',
                event.resultConfirmedAt ? formatDateTime(event.resultConfirmedAt) : '—',
              ],
              ['Abgerechnet', event.settledAt ? formatDateTime(event.settledAt) : '—'],
              ['Wetten (offen)', `${event.betCount} (${event.openBetCount})`],
              ['Märkte', String(event.markets.length)],
            ]}
          />
          <div className="mt-4 flex gap-3 text-sm">
            <Link href={`/admin/bets?eventId=${event.id}`} className="text-accent hover:underline">
              Wetten auf dieses Event
            </Link>
            <Link
              href={`/admin/audit?targetId=${event.id}`}
              className="text-accent hover:underline"
            >
              Audit-Log
            </Link>
            <Link href={`/events/${event.id}`} className="text-accent hover:underline">
              Öffentliche Ansicht
            </Link>
          </div>
        </CardContent>
      </Card>
      <ResultForm event={event} />
      <SectionTitle>Märkte</SectionTitle>
      {event.provider !== 'manual' ? (
        <p className="text-xs text-fg-muted">
          Quoten von Feed-Events steuert der Provider. Staff kann Märkte sperren, freigeben oder
          schließen.
        </p>
      ) : null}
      <MarketsTable event={event} />
    </>
  );
}
