import type { ProviderHealthDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import { ProviderCard } from '@/components/admin/health';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Odds-Provider' };

export default async function ProvidersPage() {
  const providers = await serverApi<ProviderHealthDto[]>('/admin/providers');
  return (
    <>
      <PageHeader
        title="Odds-Provider"
        description="Zustand der Datenquellen: Timeouts, Retries, Circuit Breaker, Rate Limit und Cache laufen im Worker."
      />
      <div className="space-y-3">
        {providers.map((p) => (
          <ProviderCard key={p.key} provider={p} />
        ))}
      </div>
    </>
  );
}
