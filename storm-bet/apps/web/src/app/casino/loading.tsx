import { Skeleton } from '@storm-bet/ui';
import { getT } from '@/i18n/server';

export default async function CasinoLoading() {
  const t = await getT();
  return (
    <div className="space-y-6" aria-busy="true" aria-label={t('Lädt')}>
      <Skeleton className="h-8 w-48" />
      <div className="flex gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="aspect-[4/3] w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
