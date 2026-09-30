import type { Metadata } from 'next';
import { SharedSlip } from '@/components/betslip/shared-slip';
import { PageHeader } from '@/components/sportsbook/page-header';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Geteilter Wettschein') };
}

export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const t = await getT();
  const { ids = '' } = await searchParams;
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('Geteilter Wettschein')}
        description={t(
          'Tipps, die jemand mit dir geteilt hat – mit aktuellen Quoten. Den Einsatz wählst du selbst.',
        )}
      />
      <SharedSlip ids={ids.split(',').filter(Boolean).slice(0, 20)} />
    </div>
  );
}
