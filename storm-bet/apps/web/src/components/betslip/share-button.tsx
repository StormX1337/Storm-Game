'use client';

import { toast } from '@storm-bet/ui';
import { Share2 } from 'lucide-react';
import { shareLink, slipLink } from '@/lib/share';
import { useT } from '@/i18n/client';

/** Shares picks as a link others can open as their own bet slip. */
export function ShareButton({
  selectionIds,
  label = 'Teilen',
  className,
}: {
  selectionIds: string[];
  label?: string;
  className?: string;
}) {
  const t = useT();
  if (selectionIds.length === 0) return null;
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const result = await shareLink(slipLink(selectionIds), t('STORM BET Wettschein'));
        if (result === 'copied') toast.success(t('Link kopiert'));
        else if (result === 'failed') toast.error('Link konnte nicht kopiert werden');
      }}
      className={className ?? 'inline-flex items-center gap-1 text-xs text-fg-subtle hover:text-fg'}
      data-testid="share-slip"
    >
      <Share2 className="size-3" /> {t(label)}
    </button>
  );
}
