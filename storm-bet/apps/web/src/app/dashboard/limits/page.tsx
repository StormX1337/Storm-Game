import type { LimitDto, SelfExclusionDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LimitsCard, SelfExclusionCard } from '@/components/dashboard/account-forms';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';

export const metadata: Metadata = { title: 'Limits' };

export default async function LimitsPage() {
  const [limits, exclusion] = await Promise.all([
    serverApi<LimitDto[]>('/account/limits'),
    serverApi<SelfExclusionDto>('/account/self-exclusion'),
  ]);
  return (
    <>
      <PageHeader
        title="Limits & Selbstsperre"
        description={
          <>
            Werkzeuge für verantwortungsvolles Spielen.{' '}
            <Link href="/responsible-gaming" className="text-accent hover:underline">
              Mehr erfahren
            </Link>
          </>
        }
      />
      <LimitsCard limits={limits} />
      <SelfExclusionCard exclusion={exclusion} />
    </>
  );
}
