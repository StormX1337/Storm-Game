'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Clock,
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  Network,
  Terminal,
  Users,
} from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@storm/ui';
import type { ServerLiveStats } from '@storm/types';
import { api } from '@/lib/api';
import {
  formatBytes,
  formatDate,
  formatMib,
  formatPercent,
  formatUptime,
  usagePercent,
} from '@/lib/format';
import { StatCard, UsageMeter } from '@/components/panel/stats';
import { ResourceChart, useLiveSeries } from '@/components/panel/resource-chart';
import { useServer } from '@/components/panel/server-context';
import { useServerSocket } from '@/hooks/use-server-socket';

interface HistoryPoint {
  t: string;
  cpu: number;
  memory: number;
  disk: number;
  rx: number;
  tx: number;
  players: number | null;
}

export default function ServerOverviewPage() {
  const { server, status } = useServer();
  const socket = useServerSocket(server.id);

  // The socket is the live source; the REST call seeds the first paint so the
  // page is not empty for the second it takes the socket to attach.
  const initial = useQuery({
    queryKey: ['server', server.shortId, 'stats'],
    queryFn: () => api.get<ServerLiveStats>(`/servers/${server.id}/stats`),
    refetchInterval: socket.state === 'open' ? false : 10_000,
  });

  const history = useQuery({
    queryKey: ['server', server.shortId, 'history'],
    queryFn: () =>
      api.get<HistoryPoint[]>(`/servers/${server.id}/stats/history`, { query: { hours: 6 } }),
    refetchInterval: 300_000,
  });

  const stats = socket.stats ?? initial.data ?? null;

  const liveSample = React.useMemo(
    () =>
      stats
        ? {
            cpu: stats.cpuPercent,
            memory: stats.memoryBytes,
            rx: stats.networkRx,
            tx: stats.networkTx,
          }
        : null,
    [stats],
  );
  const liveSeries = useLiveSeries(liveSample, 90);

  const memoryLimitBytes = server.limits.memoryLimit * 1024 * 1024;
  const diskLimitBytes = server.limits.diskLimit * 1024 * 1024;

  const chartData =
    liveSeries.length > 3
      ? liveSeries
      : (history.data ?? []).map((point) => ({
          t: point.t,
          cpu: point.cpu,
          memory: point.memory,
          rx: point.rx,
          tx: point.tx,
        }));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="CPU"
          value={stats ? formatPercent(stats.cpuPercent) : '—'}
          hint={
            server.limits.cpuLimit > 0
              ? `Limit ${(server.limits.cpuLimit / 100).toFixed(1)} cores`
              : 'Unlimited'
          }
          icon={Cpu}
          tone={
            stats && server.limits.cpuLimit > 0 && stats.cpuPercent > server.limits.cpuLimit * 0.9
              ? 'warning'
              : 'default'
          }
        />
        <StatCard
          label="Memory"
          value={stats ? formatBytes(stats.memoryBytes) : '—'}
          hint={`of ${formatMib(server.limits.memoryLimit)}`}
          icon={MemoryStick}
          tone={
            stats && usagePercent(stats.memoryBytes, memoryLimitBytes) > 90 ? 'warning' : 'default'
          }
        />
        <StatCard
          label="Disk"
          value={stats ? formatBytes(stats.diskBytes) : '—'}
          hint={`of ${formatMib(server.limits.diskLimit)}`}
          icon={HardDrive}
          tone={stats && usagePercent(stats.diskBytes, diskLimitBytes) > 90 ? 'warning' : 'default'}
        />
        <StatCard
          label="Uptime"
          value={stats && status === 'ONLINE' ? formatUptime(stats.uptime) : '—'}
          hint={status === 'ONLINE' ? 'Running' : 'Not running'}
          icon={Clock}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <ResourceChart
            title="CPU usage"
            data={chartData}
            series={[{ key: 'cpu', label: 'CPU', format: (value) => formatPercent(value) }]}
            yFormatter={(value) => `${value.toFixed(0)}%`}
            emptyMessage="Start the server to collect CPU samples."
          />

          <ResourceChart
            title="Memory usage"
            data={chartData}
            series={[
              {
                key: 'memory',
                label: 'Memory',
                color: 'hsl(var(--chart-2))',
                format: (value) => formatBytes(value),
              },
            ]}
            yFormatter={(value) => formatBytes(value)}
            emptyMessage="Start the server to collect memory samples."
          />

          <ResourceChart
            title="Network traffic"
            data={chartData}
            variant="line"
            series={[
              {
                key: 'rx',
                label: 'Inbound',
                color: 'hsl(var(--chart-3))',
                format: (value) => formatBytes(value),
              },
              {
                key: 'tx',
                label: 'Outbound',
                color: 'hsl(var(--chart-4))',
                format: (value) => formatBytes(value),
              },
            ]}
            yFormatter={(value) => formatBytes(value)}
            emptyMessage="Network counters appear once the server is running."
          />
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Resource limits</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <UsageMeter
                label="Memory"
                icon={MemoryStick}
                used={stats?.memoryBytes ?? 0}
                limit={memoryLimitBytes}
                formatValue={(value) => formatBytes(value)}
              />
              <UsageMeter
                label="Disk"
                icon={HardDrive}
                used={stats?.diskBytes ?? 0}
                limit={diskLimitBytes}
                formatValue={(value) => formatBytes(value)}
              />
              <UsageMeter
                label="CPU"
                icon={Cpu}
                used={stats?.cpuPercent ?? 0}
                limit={server.limits.cpuLimit}
                formatValue={(value) => `${value.toFixed(0)}%`}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <Detail label="Node" value={server.node.name} />
              <Detail label="Location" value={server.node.location} />
              <Detail label="Game" value={server.template?.name ?? 'Custom'} />
              <Detail label="Docker image" value={server.dockerImage} mono />
              <Detail
                label="Address"
                value={
                  server.primaryAllocation
                    ? `${server.primaryAllocation.ip}:${server.primaryAllocation.port}`
                    : 'Not assigned'
                }
                mono
              />
              <Detail label="Owner" value={server.owner?.username ?? '—'} />
              <Detail label="Installed" value={formatDate(server.installedAt)} />
              <Detail label="Created" value={formatDate(server.createdAt)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Quick actions</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href={`/servers/${server.shortId}/console`}>
                  <Terminal />
                  Console
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/servers/${server.shortId}/files`}>
                  <HardDrive />
                  Files
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/servers/${server.shortId}/backups`}>
                  <Activity />
                  Backups
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/servers/${server.shortId}/databases`}>
                  <Database />
                  Databases
                </Link>
              </Button>
            </CardContent>
          </Card>

          {stats?.players ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Players</CardTitle>
                <Users className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold tabular-nums">
                  {stats.players.online}
                  <span className="text-base font-normal text-muted-foreground">
                    {' '}
                    / {stats.players.max}
                  </span>
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Network allocations</CardTitle>
          <Network className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {server.allocations.map((allocation) => (
              <div
                key={allocation.id}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
              >
                <span className="font-mono text-sm">
                  {allocation.ip}:{allocation.port}
                </span>
                <span className="text-2xs uppercase text-muted-foreground">
                  {allocation.protocol}
                </span>
                {allocation.isPrimary ? (
                  <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-primary">
                    primary
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 truncate text-right ${mono ? 'font-mono text-xs' : ''}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
