'use client';

import { Button, toast } from '@storm-bet/ui';
import { MailWarning } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';
import { useT } from '@/i18n/client';

export function VerifyNotice() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      await api('/auth/resend-verification', { method: 'POST' });
      toast.success(t('Bestätigungslink gesendet'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/25 bg-warning-soft px-4 py-3">
      <MailWarning className="size-5 text-warning" aria-hidden="true" />
      <p className="flex-1 text-sm text-fg-muted">
        {t('Bitte bestätige deine E-Mail-Adresse. Wir haben dir einen Link gesendet.')}
      </p>
      <Button size="sm" variant="secondary" onClick={() => void resend()} loading={busy}>
        {t('Link erneut senden')}
      </Button>
    </div>
  );
}
