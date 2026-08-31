'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu, HardDrive, MemoryStick, Save } from 'lucide-react';
import { Permission } from '@storm/types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { useServer } from '@/components/panel/server-context';

interface EditableLimits {
  cpuLimit: number;
  memoryLimit: number;
  diskLimit: number;
  swapLimit: number;
}

/**
 * Changing what a running server is allowed to use.
 *
 * A server that gets killed for running out of memory needs a bigger limit,
 * and until this existed the only way to give it one was to delete the server
 * and build it again — losing the world that made it worth keeping. The create
 * form has always said these can be changed later; this is where.
 */
export function ServerLimitsCard() {
  const { server } = useServer();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const current: EditableLimits = React.useMemo(
    () => ({
      cpuLimit: server.limits.cpuLimit,
      memoryLimit: server.limits.memoryLimit,
      diskLimit: server.limits.diskLimit,
      swapLimit: server.limits.swapLimit,
    }),
    [server.limits],
  );

  const [form, setForm] = React.useState<EditableLimits>(current);
  React.useEffect(() => setForm(current), [current]);

  const save = useMutation({
    mutationFn: () => api.patch(`/servers/${server.id}`, { limits: form }),
    onSuccess: () => {
      toast.success('Limits saved', 'They take effect the next time the server starts.');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
      void queryClient.invalidateQueries({ queryKey: ['server', server.id] });
    },
    // The API's own message names what is short — the account's allowance or
    // the node's — which is the part worth reading.
    onError: (error) => toast.error('Could not change the limits', errorMessage(error)),
  });

  // Mirrors the API exactly: it allows the panel owner and anyone holding
  // admin.servers, and nobody else — a server's own owner must not be able to
  // raise their own allowance. Not `isAdmin`, which also counts
  // admin.dashboard and would show this card to someone the API refuses.
  if (!can(Permission.ADMIN_SERVERS)) return null;

  const set = (key: keyof EditableLimits) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((previous) => ({ ...previous, [key]: Number(event.target.value) || 0 }));
  };

  const dirty = (Object.keys(form) as (keyof EditableLimits)[]).some(
    (key) => form[key] !== current[key],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resource limits</CardTitle>
        <CardDescription>
          Hard limits on the container. Raising memory is the fix for a server the host keeps
          killing. Changes apply on the next start, so restart the server afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="CPU" htmlFor="limit-cpu" hint="100% is one core. 0 is unlimited.">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                id="limit-cpu"
                type="number"
                min={0}
                max={6400}
                step={25}
                value={form.cpuLimit}
                onChange={set('cpuLimit')}
              />
              <span className="text-sm text-muted-foreground">%</span>
            </div>
          </Field>

          <Field label="Memory" htmlFor="limit-memory" hint="At least 128 MiB.">
            <div className="flex items-center gap-2">
              <MemoryStick className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                id="limit-memory"
                type="number"
                min={128}
                step={256}
                value={form.memoryLimit}
                onChange={set('memoryLimit')}
              />
              <span className="text-sm text-muted-foreground">MiB</span>
            </div>
          </Field>

          <Field label="Disk" htmlFor="limit-disk" hint="At least 512 MiB.">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                id="limit-disk"
                type="number"
                min={512}
                step={1024}
                value={form.diskLimit}
                onChange={set('diskLimit')}
              />
              <span className="text-sm text-muted-foreground">MiB</span>
            </div>
          </Field>
        </div>

        <Field
          label="Swap"
          htmlFor="limit-swap"
          hint="0 for none, -1 for unlimited. Swap is far slower than memory — reach for the memory limit first."
        >
          <Input
            id="limit-swap"
            type="number"
            min={-1}
            step={256}
            value={form.swapLimit}
            onChange={set('swapLimit')}
            className="max-w-[200px]"
          />
        </Field>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
            <Save />
            Save limits
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
