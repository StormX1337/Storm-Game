import type { EventDetailDto } from '@storm-bet/types';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EventMarkets } from '@/components/sportsbook/event-markets';
import { Scoreboard } from '@/components/sportsbook/scoreboard';
import { serverApi, ServerApiError } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

async function load(id: string): Promise<EventDetailDto> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  try {
    return await serverApi<EventDetailDto>(`/events/${id}`);
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 404) notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ eventId: string }>;
}): Promise<Metadata> {
  const { eventId } = await params;
  try {
    const event = await load(eventId);
    return { title: `${event.home.name} – ${event.away.name}` };
  } catch {
    return { title: 'Event' };
  }
}

export default async function EventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const event = await load(eventId);
  return (
    <div className="space-y-4">
      <Link
        href={`/sports/${event.sport.key}`}
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> {event.sport.name}
      </Link>
      <Scoreboard event={event} />
      <EventMarkets event={event} />
    </div>
  );
}
