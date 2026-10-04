'use client';

import type { FeedItemDto, Paginated } from '@storm-bet/types';
import { LoadMore } from '../dashboard/load-more';
import { FeedCard } from './feed-card';

export function FeedList({ initial, filter }: { initial: Paginated<FeedItemDto>; filter: string }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {initial.items.map((item) => (
        <FeedCard key={item.id} item={item} />
      ))}
      <LoadMore<FeedItemDto>
        path={`/feed?filter=${filter}&limit=20`}
        initialCursor={initial.nextCursor}
        render={(items) => items.map((item) => <FeedCard key={item.id} item={item} />)}
      />
    </div>
  );
}
