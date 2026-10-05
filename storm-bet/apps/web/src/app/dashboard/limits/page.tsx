import type { LimitDto, SelfExclusionDto } from '@storm-bet/types';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LimitsCard, SelfExclusionCard } from '@/components/dashboard/account-forms';
import { PageHeader } from '@/components/sportsbook/page-header';
import { serverApi } from '@/lib/server-api';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Limits') };
}

export default async function LimitsPage() {
  const t = await getT();
  const [limits, exclusion] = await Promise.all([
    serverApi<LimitDto[]>('/account/limits'),
    serverApi<SelfExclusionDto>('/account/self-exclusion'),
  ]);
  return (
    <>
      <PageHeader
        title={t('Limits & Selbstsperre')}
        description={
          <>
            {t('Werkzeuge für verantwortungsvolles Spielen.')}{' '}
            <Link href="/responsible-gaming" className="text-accent-strong hover:underline">
              {t('Mehr erfahren')}
            </Link>
          </>
        }
      />
      <LimitsCard limits={limits} />
      <SelfExclusionCard exclusion={exclusion} />
    </>
  );
}
