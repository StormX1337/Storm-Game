import { Skeleton } from '@storm-bet/ui';
import { EventListSkeleton } from '@/components/sportsbook/event-list';
import { MatchCardSkeleton } from '@/components/sportsbook/match-card';

/** Shown while a sportsbook page streams in: the layout's shapes, never a blank screen. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <MatchCardSkeleton />
        <MatchCardSkeleton className="max-md:hidden" />
      </div>
      <EventListSkeleton rows={4} />
    </div>
  );
}
