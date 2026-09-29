'use client';

import { Button, ConfirmDialog, Field, Textarea, toast, type ButtonProps } from '@storm-bet/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api-client';

/**
 * Every staff mutation asks for a reason; it is stored in the audit log with
 * the change. The dialog enforces it before the request is even sent.
 */
export function ReasonAction({
  label,
  title,
  description,
  path,
  method = 'POST',
  body = {},
  variant = 'outline',
  size = 'sm',
  destructive = false,
  successMessage = 'Gespeichert',
  onDone,
  children,
  extraValid = true,
}: {
  label: React.ReactNode;
  title: string;
  description?: string;
  path: string;
  method?: 'POST' | 'PATCH' | 'PUT';
  body?: Record<string, unknown>;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  destructive?: boolean;
  successMessage?: string;
  onDone?: (result: unknown) => void;
  children?: React.ReactNode;
  extraValid?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= 3 && extraValid;
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        destructive={destructive}
        loading={busy}
        confirmDisabled={!valid}
        onConfirm={async () => {
          setBusy(true);
          try {
            const result = await api(path, { method, body: { ...body, reason: reason.trim() } });
            toast.success(successMessage);
            setOpen(false);
            setReason('');
            onDone?.(result);
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-3">
          {children}
          <Field label="Begründung (wird im Audit-Log gespeichert)" htmlFor="reason">
            <Textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Mindestens 3 Zeichen"
            />
          </Field>
        </div>
      </ConfirmDialog>
    </>
  );
}
