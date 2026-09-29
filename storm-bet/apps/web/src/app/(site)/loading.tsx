import { Skeleton } from '@storm-bet/ui';
import { EventListSkeleton } from '@/components/sportsbook/event-list';

export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-56" />
      <EventListSkeleton />
    </div>
  );
}
