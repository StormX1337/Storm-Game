'use client';

import { Button, toast } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useT } from '@/i18n/client';
import { api, errorMessage } from '@/lib/api-client';

/** Taking part shows the display name and results to everyone; leaving hides them at once. */
export function LeaderboardJoin({ optIn }: { optIn: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await api('/account/leaderboard', { method: 'PUT', body: { optIn: !optIn } });
      toast.success(optIn ? t('Du bist nicht mehr in der Rangliste') : t('Du bist dabei'));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={optIn ? 'outline' : 'primary'}
      loading={busy}
      onClick={() => void toggle()}
      data-testid="leaderboard-join"
    >
      {optIn ? t('Nicht mehr anzeigen') : t('Mitmachen')}
    </Button>
  );
}
