'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Plus, ShieldCheck, Trash2, UserCog, UserMinus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Skeleton,
  Switch,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

interface PlayerLists {
  live: boolean;
  whitelistEnabled: boolean;
  operators: { uuid: string; name: string; level: number }[];
  whitelist: { uuid: string; name: string }[];
  bans: { name: string; reason: string; created: string | null; source: string }[];
  ipBans: { ip: string; reason: string; created: string | null }[];
}

/**
 * Operators, the whitelist and bans.
 *
 * Every change goes out as a console command, so the server has to be running.
 * That is not a limitation the panel invented: Minecraft holds these lists in
 * memory while it runs and rewrites the files itself, so a panel that edited
 * them underneath would show a change the game never had.
 */
export default function ServerPlayersPage() {
  const { server, can, status } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const mayManage = can('servers.players');
  const running = status === 'ONLINE' || status === 'STARTING';

  const lists = useQuery({
    queryKey: ['server', server.id, 'players'],
    queryFn: () => api.get<PlayerLists>(`/servers/${server.id}/players`),
    refetchInterval: running ? 20_000 : false,
  });

  const act = useMutation({
    mutationFn: (job: { method: 'POST' | 'DELETE'; path: string; payload?: unknown }) =>
      job.method === 'POST'
        ? api.post<{ message: string }>(`/servers/${server.id}/players/${job.path}`, job.payload)
        : api.delete<{ message: string }>(`/servers/${server.id}/players/${job.path}`),
    onSuccess: (result) => {
      toast.success('Done', result.message);
      void queryClient.invalidateQueries({ queryKey: ['server', server.id, 'players'] });
    },
    onError: (error) => toast.error('That did not work', errorMessage(error)),
  });

  const data = lists.data;

  if (lists.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!running ? (
        <Card className="border-warning/30">
          <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sm">
            <ShieldCheck className="h-4 w-4 shrink-0 text-warning" />
            <span className="font-medium">The server is not running.</span>
            <span className="text-muted-foreground">
              These lists are what it last wrote. Start it to change them — Minecraft owns them
              while it runs, so editing the files underneath would be lost.
            </span>
          </CardContent>
        </Card>
      ) : null}

      <PlayerList
        title="Operators"
        description="Full in-game command access. Give this out sparingly."
        icon={UserCog}
        entries={(data?.operators ?? []).map((entry) => ({
          key: entry.uuid || entry.name,
          label: entry.name,
          detail: `level ${entry.level}`,
        }))}
        addLabel="Make operator"
        emptyText="Nobody is an operator."
        disabled={!mayManage || !running || act.isPending}
        onAdd={(name) => act.mutate({ method: 'POST', path: 'operators', payload: { name } })}
        onRemove={(name) =>
          act.mutate({ method: 'DELETE', path: `operators/${encodeURIComponent(name)}` })
        }
        removeIcon={UserMinus}
      />

      <PlayerList
        title="Whitelist"
        description="When the whitelist is on, only these players may join."
        icon={ShieldCheck}
        entries={(data?.whitelist ?? []).map((entry) => ({
          key: entry.uuid || entry.name,
          label: entry.name,
        }))}
        addLabel="Add to whitelist"
        emptyText="The whitelist is empty."
        disabled={!mayManage || !running || act.isPending}
        onAdd={(name) => act.mutate({ method: 'POST', path: 'whitelist', payload: { name } })}
        onRemove={(name) =>
          act.mutate({ method: 'DELETE', path: `whitelist/${encodeURIComponent(name)}` })
        }
        header={
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={data?.whitelistEnabled ?? false}
              disabled={!mayManage || !running || act.isPending}
              onCheckedChange={(enabled) =>
                act.mutate({ method: 'POST', path: 'whitelist/enabled', payload: { enabled } })
              }
              aria-label="Enforce the whitelist"
            />
            <span className="text-muted-foreground">Enforce</span>
          </label>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-destructive" />
            Bans
          </CardTitle>
          <CardDescription>Players and addresses that cannot join.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <BanForm
            disabled={!mayManage || !running || act.isPending}
            onBan={(name, reason) =>
              act.mutate({ method: 'POST', path: 'bans', payload: { name, reason } })
            }
          />

          {(data?.bans ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is banned.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data?.bans.map((ban) => (
                <li
                  key={ban.name}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{ban.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {ban.reason || 'No reason given'}
                      {ban.created ? ` · ${formatDate(ban.created)}` : ''}
                    </p>
                  </div>
                  {mayManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!running || act.isPending}
                      onClick={async () => {
                        const yes = await confirm({
                          title: `Unban ${ban.name}?`,
                          description: 'They will be able to join again straight away.',
                          confirmLabel: 'Unban',
                        });
                        if (yes) {
                          act.mutate({
                            method: 'DELETE',
                            path: `bans/${encodeURIComponent(ban.name)}`,
                          });
                        }
                      }}
                    >
                      <Trash2 />
                      Unban
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {(data?.ipBans ?? []).length > 0 ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm font-medium">Banned addresses</p>
              <ul className="divide-y divide-border">
                {data?.ipBans.map((ban) => (
                  <li
                    key={ban.ip}
                    className="flex flex-wrap items-center justify-between gap-2 py-2"
                  >
                    <span className="font-mono text-sm">{ban.ip}</span>
                    {mayManage ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!running || act.isPending}
                        onClick={() =>
                          act.mutate({
                            method: 'DELETE',
                            path: `ip-bans/${encodeURIComponent(ban.ip)}`,
                          })
                        }
                      >
                        Unban
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function PlayerList({
  title,
  description,
  icon: Icon,
  entries,
  addLabel,
  emptyText,
  disabled,
  onAdd,
  onRemove,
  removeIcon: RemoveIcon = Trash2,
  header,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  entries: { key: string; label: string; detail?: string }[];
  addLabel: string;
  emptyText: string;
  disabled: boolean;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  removeIcon?: React.ComponentType<{ className?: string }>;
  header?: React.ReactNode;
}) {
  const [name, setName] = React.useState('');

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {header}
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            onAdd(trimmed);
            setName('');
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Player name"
            aria-label={addLabel}
            disabled={disabled}
          />
          <Button type="submit" size="sm" disabled={disabled || !name.trim()}>
            <Plus />
            Add
          </Button>
        </form>

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li
                key={entry.key}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{entry.label}</span>
                  {entry.detail ? <Badge variant="secondary">{entry.detail}</Badge> : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => onRemove(entry.label)}
                >
                  <RemoveIcon className="h-4 w-4" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BanForm({
  disabled,
  onBan,
}: {
  disabled: boolean;
  onBan: (name: string, reason: string | undefined) => void;
}) {
  const [name, setName] = React.useState('');
  const [reason, setReason] = React.useState('');

  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        onBan(trimmed, reason.trim() || undefined);
        setName('');
        setReason('');
      }}
    >
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Player name"
        aria-label="Ban a player"
        disabled={disabled}
        className="max-w-[200px]"
      />
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional)"
        aria-label="Ban reason"
        disabled={disabled}
      />
      <Button type="submit" variant="destructive" size="sm" disabled={disabled || !name.trim()}>
        <Ban />
        Ban
      </Button>
    </form>
  );
}
