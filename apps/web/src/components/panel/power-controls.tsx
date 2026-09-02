'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Play, RotateCw, Skull, Square } from 'lucide-react';
import { Button, useConfirm, useToast } from '@storm/ui';
import type { ServerStatus } from '@storm/types';
import { api, errorMessage } from '@/lib/api';

type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

const RUNNING: ServerStatus[] = ['ONLINE', 'STARTING', 'STOPPING'];
const BUSY: ServerStatus[] = ['INSTALLING', 'REINSTALLING', 'SUSPENDED'];

/**
 * Power buttons for a server. Availability is driven by the live status so a
 * customer cannot, say, press Start on a server that is already booting.
 */
export function PowerControls({
  serverId,
  status,
  can,
  onAction,
  size = 'default',
}: {
  serverId: string;
  status: ServerStatus;
  can: (...permissions: string[]) => boolean;
  onAction?: (action: PowerAction) => void;
  size?: 'sm' | 'default';
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, setPending] = React.useState<PowerAction | null>(null);

  const mutation = useMutation({
    mutationFn: (action: PowerAction) => api.post(`/servers/${serverId}/power`, { action }),
    onSuccess: (_data, action) => {
      toast.success(
        action === 'start'
          ? 'Starting server'
          : action === 'stop'
            ? 'Stopping server'
            : action === 'restart'
              ? 'Restarting server'
              : 'Killing server',
        'The node has accepted the request.',
      );
      onAction?.(action);
    },
    onError: (error) => toast.error('Power action failed', errorMessage(error)),
    onSettled: () => setPending(null),
  });

  const run = async (action: PowerAction): Promise<void> => {
    if (action === 'kill') {
      const confirmed = await confirm({
        title: 'Force kill this server?',
        description:
          'The process is terminated immediately with no chance to save. Unsaved world data may be lost. Use Stop unless the server is unresponsive.',
        confirmLabel: 'Force kill',
        destructive: true,
      });
      if (!confirmed) return;
    }

    setPending(action);
    mutation.mutate(action);
  };

  const isRunning = RUNNING.includes(status);
  const isBusy = BUSY.includes(status);
  const transitioning = status === 'STARTING' || status === 'STOPPING';

  const canStart = !isRunning && !isBusy && can('servers.start');
  const canRestart = !isBusy && can('servers.restart');
  const canStop = isRunning && can('servers.stop');
  // Kill stays available while a server is stuck mid-transition, which is
  // exactly when it is needed.
  const canKill = (isRunning || transitioning) && can('servers.kill');

  /*
   * Exactly one filled button, and it is the one you came here to press.
   *
   * The row used to carry three different treatments at once — a filled
   * green, two filled greys and an outlined red — which reads as four
   * unrelated things rather than one control. Worse, the filled one was
   * always Start, so a running server offered a bright disabled button and
   * left the action you actually wanted looking secondary.
   *
   * A filled button that cannot be pressed is the other half of the same
   * problem: dimming a saturated fill to 45% leaves a muddy shape that still
   * draws the eye. So a button drops to the outline treatment the moment it
   * is unavailable, and the fill moves to whichever action is live.
   */
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size={size}
        variant={canStart ? 'success' : 'outline'}
        onClick={() => void run('start')}
        disabled={!canStart}
        loading={pending === 'start'}
      >
        <Play />
        Start
      </Button>

      <Button
        size={size}
        variant="outline"
        onClick={() => void run('restart')}
        disabled={!canRestart}
        loading={pending === 'restart'}
      >
        <RotateCw />
        Restart
      </Button>

      <Button
        size={size}
        variant={canStop ? 'secondary' : 'outline'}
        onClick={() => void run('stop')}
        disabled={!canStop}
        loading={pending === 'stop'}
      >
        <Square />
        Stop
      </Button>

      <Button
        size={size}
        variant="outline"
        onClick={() => void run('kill')}
        disabled={!canKill}
        loading={pending === 'kill'}
        className="text-destructive hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
      >
        <Skull />
        Kill
      </Button>
    </div>
  );
}
