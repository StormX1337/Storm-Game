'use client';

import { toast } from '@storm-bet/ui';
import { Users } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { api, errorMessage } from '@/lib/api-client';

/** Shows or hides one's own bet in the tip feed (picks and odds only). */
export function FeedToggle({ betId, initial }: { betId: string; initial: boolean }) {
  const t = useT();
  const [shared, setShared] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const res = await api<{ shared: boolean }>(`/bets/${betId}/share`, {
        method: shared ? 'DELETE' : 'POST',
      });
      setShared(res.shared);
      toast.success(res.shared ? t('Im Tipp-Feed geteilt') : t('Aus dem Tipp-Feed entfernt'));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      className="inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg disabled:opacity-50"
      aria-pressed={shared}
      data-testid="feed-toggle"
    >
      <Users className="size-3" aria-hidden="true" />
      {shared ? t('Im Feed · entfernen') : t('Im Feed teilen')}
    </button>
  );
}
