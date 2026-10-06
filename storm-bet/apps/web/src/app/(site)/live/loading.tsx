import { Skeleton } from '@storm-bet/ui';
import { MatchCardSkeleton } from '@/components/sportsbook/match-card';

/** Live page while it loads: header, view tabs, filter chips and live cards. */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-20" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-12 w-full rounded-xl sm:w-80" />
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="grid items-start gap-3 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <MatchCardSkeleton key={i} className={i > 1 ? 'max-md:hidden' : undefined} />
        ))}
      </div>
    </div>
  );
}
