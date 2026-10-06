import { Skeleton } from '@storm-bet/ui';
import { EventListSkeleton } from '@/components/sportsbook/event-list';

/** Same shapes as the sport page: header, tabs, chips, league list. */
export default function Loading() {
  return (
    <div className="space-y-5" aria-busy="true">
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <Skeleton className="h-12 w-full rounded-xl sm:w-96" />
      <div className="flex gap-2 overflow-hidden">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-9 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <EventListSkeleton rows={5} />
    </div>
  );
}
