import type { Metadata } from 'next';
import { SharedSlip } from '@/components/betslip/shared-slip';
import { PageHeader } from '@/components/sportsbook/page-header';

export const metadata: Metadata = { title: 'Geteilter Wettschein' };

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids = '' } = await searchParams;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Geteilter Wettschein"
        description="Tipps, die jemand mit dir geteilt hat – mit aktuellen Quoten. Den Einsatz wählst du selbst."
      />
      <SharedSlip ids={ids.split(',').filter(Boolean).slice(0, 20)} />
    </div>
  );
}
