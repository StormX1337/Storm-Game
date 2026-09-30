'use client';

import type { WalletDto } from '@storm-bet/types';
import { Button, toast } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';
import { announceWalletChange } from '../providers/session';
import { useT } from '@/i18n/client';

export function TopUpButton() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const topUp = async () => {
    setBusy(true);
    try {
      const result = await api<{ wallet: WalletDto; credited: number }>('/wallet/top-up', {
        method: 'POST',
      });
      announceWalletChange(result.wallet);
      toast.success(`${formatMoney(result.credited)} gutgeschrieben`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" onClick={() => void topUp()} loading={busy}>
      {t('Demo-Guthaben aufladen')}
    </Button>
  );
}
