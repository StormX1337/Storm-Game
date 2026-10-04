import type { Metadata } from 'next';
import { SearchEvents } from '@/components/search/search-events';
import { getT } from '@/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Suche') };
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <SearchEvents initialQuery={q?.slice(0, 40) ?? ''} />;
}
