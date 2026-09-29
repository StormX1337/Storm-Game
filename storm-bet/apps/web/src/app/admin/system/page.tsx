import type { SystemHealthDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import { QueuesCard, SystemHealthCard } from '@/components/admin/health';
import { PageHeader } from '@/components/sportsbook/page-header';
import { formatDateTime } from '@/lib/format';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'System' };

export default async function SystemPage() {
  const health = await serverApi<SystemHealthDto>('/admin/system');
  return (
    <>
      <PageHeader title="System Health" description={`Stand ${formatDateTime(health.time)}`} />
      <div className="grid gap-4 xl:grid-cols-2">
        <SystemHealthCard health={health} />
        <QueuesCard health={health} />
      </div>
    </>
  );
}
