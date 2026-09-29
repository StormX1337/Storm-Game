import type { AdminCatalogDto } from '@storm-bet/types';
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CreateEventForm } from '@/components/admin/create-event';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Event anlegen' };

export default async function NewEventPage() {
  const catalog = await serverApi<AdminCatalogDto>('/admin/catalog');
  return (
    <>
      <Link
        href="/admin/events"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeft className="size-4" aria-hidden="true" /> Events
      </Link>
      <PageHeader
        title="Event anlegen"
        description="Manuelle Events sind Demo-Events; Quoten setzt der Trader, das Ergebnis wird im Admin erfasst."
      />
      <CreateEventForm catalog={catalog} />
    </>
  );
}
