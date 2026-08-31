'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Terminal } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { useServer } from '@/components/panel/server-context';

interface SftpDetails {
  host: string;
  port: number;
  username: string;
  password: string | null;
}

export default function SftpPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const allowed = can('servers.sftp');

  const sftp = useQuery({
    queryKey: ['server', server.shortId, 'sftp'],
    queryFn: () => api.get<SftpDetails>(`/servers/${server.id}/sftp`),
    enabled: allowed,
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post<{ password: string }>(`/servers/${server.id}/sftp/reset`, {}),
    onSuccess: () => {
      toast.success('SFTP password rotated', 'The new password is shown below. It is not stored in readable form.');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'sftp'] });
    },
    onError: (error) => toast.error('Could not rotate the password', errorMessage(error)),
  });

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  };

  async function onRotate(): Promise<void> {
    const confirmed = await confirm({
      title: 'Rotate the SFTP password?',
      description:
        'Any client still using the old password stops working immediately, including scripts and sync tools.',
      confirmLabel: 'Rotate password',
    });
    if (confirmed) resetPassword.mutate();
  }

  if (!allowed) {
    return (
      <EmptyState
        icon={KeyRound}
        title="No SFTP access"
        description="Your access to this server does not include SFTP."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>SFTP access</CardTitle>
            <CardDescription>
              Connect any SFTP client to manage files outside the browser — useful for large uploads
              the file manager would struggle with.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRotate} loading={resetPassword.isPending}>
            <KeyRound />
            Rotate password
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {sftp.isLoading ? (
            <Skeleton className="h-24" />
          ) : sftp.data ? (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Row label="Host" value={sftp.data.host} onCopy={copy} />
                <Row label="Port" value={String(sftp.data.port)} onCopy={copy} />
                <Row label="Username" value={sftp.data.username} onCopy={copy} />
                <Row
                  label="Password"
                  value={sftp.data.password ?? 'Hidden — rotate to reveal'}
                  onCopy={sftp.data.password ? copy : undefined}
                />
              </dl>
              <div className="rounded-lg border border-border bg-secondary/40 p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Quick connect</p>
                <code className="block break-all font-mono text-xs">
                  sftp://{sftp.data.username}@{sftp.data.host}:{sftp.data.port}
                </code>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">SFTP details are unavailable.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Terminal className="h-4 w-4" />
            Connecting
          </CardTitle>
          <CardDescription>
            The username carries the server id, so one account can hold access to several servers
            without the credentials colliding.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Point your client at the host and port above. You land in this server&apos;s own
            directory and cannot leave it — paths outside are refused by the node, not hidden by the
            client.
          </p>
          <p>
            The password is not the one you sign in to the panel with, and the panel cannot show it
            again after it is set. Rotate it to get a new one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: (value: string, label: string) => Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-xs" title={value}>
          {value}
        </span>
        {onCopy ? (
          <button
            type="button"
            onClick={() => void onCopy(value, label)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Copy ${label}`}
          >
            <Copy className="h-3 w-3" />
          </button>
        ) : null}
      </dd>
    </div>
  );
}
