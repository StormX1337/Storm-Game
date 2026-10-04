'use client';

import type { FeedItemDto } from '@storm-bet/types';
import { cn, toast } from '@storm-bet/ui';
import { Heart, UserCheck, UserPlus } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useT } from '@/i18n/client';
import { api, errorMessage } from '@/lib/api-client';

/** Follow state per author, shared by all cards of the list (one author, many tips). */
const FollowContext = createContext<{
  following: (item: FeedItemDto) => boolean;
  set: (authorId: string, value: boolean) => void;
}>({ following: (item) => item.following, set: () => undefined });

export function FollowProvider({ children }: { children: React.ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const following = useCallback(
    (item: FeedItemDto) => overrides[item.authorId] ?? item.following,
    [overrides],
  );
  const set = useCallback(
    (authorId: string, value: boolean) => setOverrides((o) => ({ ...o, [authorId]: value })),
    [],
  );
  const value = useMemo(() => ({ following, set }), [following, set]);
  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}

export function FollowButton({ item }: { item: FeedItemDto }) {
  const t = useT();
  const { following, set } = useContext(FollowContext);
  const [busy, setBusy] = useState(false);
  if (item.own) return null;
  const on = following(item);
  const toggle = async () => {
    setBusy(true);
    try {
      await api(`/users/${item.authorId}/follow`, { method: on ? 'DELETE' : 'POST' });
      set(item.authorId, !on);
      toast.success(
        on ? t('Du folgst {0} nicht mehr', [item.author]) : t('Du folgst {0}', [item.author]),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={on}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60',
        on
          ? 'border-border text-fg-muted hover:text-fg'
          : 'border-accent bg-accent-soft text-accent-strong hover:bg-accent/25',
      )}
      data-testid="feed-follow"
    >
      {on ? <UserCheck className="size-3.5" /> : <UserPlus className="size-3.5" />}
      {on ? t('Gefolgt') : t('Folgen')}
    </button>
  );
}

export function LikeButton({ item }: { item: FeedItemDto }) {
  const t = useT();
  const [state, setState] = useState({ liked: item.liked, likes: item.likes });
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      setState(
        await api<{ liked: boolean; likes: number }>(`/feed/${item.id}/like`, {
          method: state.liked ? 'DELETE' : 'POST',
        }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy || item.own}
      aria-pressed={state.liked}
      aria-label={state.liked ? t('Gefällt mir nicht mehr') : t('Gefällt mir')}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition-colors disabled:cursor-default',
        state.liked ? 'text-live' : 'text-fg-muted enabled:hover:text-fg',
      )}
      data-testid="feed-like"
    >
      <Heart className={cn('size-4', state.liked && 'fill-current')} aria-hidden="true" />
      <span className="tabular">{state.likes}</span>
    </button>
  );
}
