'use client';

import * as React from 'react';
import Link from 'next/link';
import { Cpu, HardDrive, MapPin, MemoryStick, Network } from 'lucide-react';
import { Card, cn } from '@storm/ui';
import type { ServerSummary } from '@storm/types';
import { formatBytes, formatMib, usagePercent } from '@/lib/format';
import { ServerStatusBadge } from './stats';
import { useAccountSocket } from '@/hooks/use-account-socket';

/**
 * Server tile. Status and usage come from the account websocket when it has a
 * sample, so a card reflects reality without polling per server.
 */
export function ServerCard({
  server,
  compact = false,
}: {
  server: ServerSummary;
  compact?: boolean;
}) {
  const { servers: live } = useAccountSocket();
  const liveState = live[server.id];

  const status = liveState?.status ?? server.status;
  const stats = liveState?.stats;

  const memoryLimitBytes = server.limits.memoryLimit * 1024 * 1024;
  const diskLimitBytes = server.limits.diskLimit * 1024 * 1024;

  const address = server.primaryAllocation
    ? `${server.primaryAllocation.ip}:${server.primaryAllocation.port}`
    : 'No port assigned';

  return (
    <Link href={`/servers/${server.shortId}`} className="group block focus:outline-none">
      <Card
        className={cn(
          'storm-interactive h-full p-4',
          'hover:border-primary/40 group-focus-visible:border-primary',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="truncate font-semibold leading-tight">{server.name}</p>
            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              {server.node.name}
              {server.template ? ` · ${server.template.game}` : null}
            </p>
          </div>
          <ServerStatusBadge status={status} />
        </div>

        <div className="mt-3 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <Network className="h-3 w-3 shrink-0" />
          <span className="truncate">{address}</span>
        </div>

        {compact ? null : <div className="my-3 h-px bg-border" />}

        <div className={cn('grid grid-cols-3 gap-3', compact ? 'mt-3' : '')}>
          <MiniMeter
            icon={Cpu}
            label="CPU"
            value={stats ? `${stats.cpuPercent.toFixed(0)}%` : '—'}
            percent={
              stats && server.limits.cpuLimit > 0
                ? usagePercent(stats.cpuPercent, server.limits.cpuLimit)
                : 0
            }
          />
          <MiniMeter
            icon={MemoryStick}
            label="Memory"
            value={
              stats ? formatBytes(stats.memoryBytes, 0) : formatMib(server.limits.memoryLimit, 0)
            }
            percent={stats ? usagePercent(stats.memoryBytes, memoryLimitBytes) : 0}
          />
          <MiniMeter
            icon={HardDrive}
            label="Disk"
            value={stats ? formatBytes(stats.diskBytes, 0) : formatMib(server.limits.diskLimit, 0)}
            percent={stats ? usagePercent(stats.diskBytes, diskLimitBytes) : 0}
          />
        </div>
      </Card>
    </Link>
  );
}

function MiniMeter({
  icon: Icon,
  label,
  value,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  percent: number;
}) {
  const tone = percent >= 90 ? 'bg-destructive' : percent >= 75 ? 'bg-warning' : 'bg-primary';

  return (
    <div className="min-w-0 space-y-1.5">
      <p className="flex items-center gap-1 truncate text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        {label}
      </p>
      <p className="truncate text-sm font-medium tabular-nums">{value}</p>
      <div className="h-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full transition-all duration-500', tone)}
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
    </div>
  );
}
