'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Cpu,
  HardDrive,
  MemoryStick,
  Plus,
  Power,
  Server,
} from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from '@storm/ui';
import type { DashboardOverview, ServerSummary } from '@storm/types';
import { api, apiPaginated } from '@/lib/api';
import { formatBytes, formatMib, formatRelative, humaniseEvent } from '@/lib/format';
import { StatCard, UsageMeter } from '@/components/panel/stats';
import { ServerCard } from '@/components/panel/server-card';
import { useAuth } from '@/lib/auth-context';

export default function DashboardPage() {
  const { user } = useAuth();

  const overview = useQuery({
    queryKey: ['dashboard', 'overview'],
    queryFn: () => api.get<DashboardOverview>('/overview'),
    refetchInterval: 60_000,
  });

  const servers = useQuery({
    queryKey: ['servers', 'dashboard'],
    queryFn: () => apiPaginated<ServerSummary>('/servers', { query: { perPage: 6 } }),
  });

  const data = overview.data;
  const greeting = user?.firstName ? `Welcome back, ${user.firstName}` : 'Welcome back';

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
          <p className="text-sm text-muted-foreground">
            Here is how your infrastructure is doing right now.
          </p>
        </div>
        <Button asChild>
          <Link href="/servers/new">
            <Plus />
            Create server
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total servers"
          value={data?.servers.total ?? 0}
          icon={Server}
          loading={overview.isLoading}
          hint={
            data && data.servers.installing > 0
              ? `${data.servers.installing} installing`
              : undefined
          }
        />
        <StatCard
          label="Online"
          value={data?.servers.online ?? 0}
          icon={Power}
          tone="success"
          loading={overview.isLoading}
        />
        <StatCard
          label="Offline"
          value={data?.servers.offline ?? 0}
          icon={Power}
          loading={overview.isLoading}
          hint={
            data && data.servers.suspended > 0 ? `${data.servers.suspended} suspended` : undefined
          }
        />
        <StatCard
          label="Memory in use"
          value={formatBytes(data?.resources.memoryUsed ?? 0)}
          hint={`of ${formatBytes(data?.resources.memoryAllocated ?? 0)} allocated`}
          icon={MemoryStick}
          loading={overview.isLoading}
        />
      </div>

      {/* `items-start` so each column ends where its content does. Stretched
          to match its taller neighbour, the server list grew a half-screen of
          empty card below the last server. */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Your servers</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/servers">
                View all
                <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {servers.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-32" />
                ))}
              </div>
            ) : servers.data?.items.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {servers.data.items.map((server) => (
                  <ServerCard key={server.id} server={server} compact />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Server}
                title="No servers yet"
                description="Create your first game server and it will appear here."
                action={
                  <Button asChild size="sm">
                    <Link href="/servers/new">
                      <Plus />
                      Create server
                    </Link>
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Allocated resources</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <UsageMeter
                label="Memory"
                icon={MemoryStick}
                used={data?.resources.memoryUsed ?? 0}
                limit={data?.resources.memoryAllocated ?? 0}
                formatValue={formatBytes}
              />
              <UsageMeter
                label="Disk"
                icon={HardDrive}
                used={data?.resources.diskUsed ?? 0}
                limit={data?.resources.diskAllocated ?? 0}
                formatValue={formatBytes}
              />
              <div className="flex items-center justify-between border-t border-border pt-4 text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Cpu className="h-3.5 w-3.5" />
                  CPU allocated
                </span>
                <span className="font-medium tabular-nums">
                  {((data?.resources.cpuAllocated ?? 0) / 100).toFixed(1)} cores
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Activity className="h-3.5 w-3.5" />
                  Network
                </span>
                <span className="font-medium tabular-nums">
                  ↓ {formatBytes(data?.resources.networkRx ?? 0)} · ↑{' '}
                  {formatBytes(data?.resources.networkTx ?? 0)}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent>
              {overview.isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((key) => (
                    <Skeleton key={key} className="h-9" />
                  ))}
                </div>
              ) : data?.recentActivity.length ? (
                <ul className="space-y-3">
                  {data.recentActivity.slice(0, 8).map((entry) => (
                    <li key={entry.id} className="flex items-start gap-2.5 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate leading-snug">{humaniseEvent(entry.event)}</p>
                        <p className="text-xs text-muted-foreground">
                          {entry.user?.username ?? 'system'} · {formatRelative(entry.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Activity will appear here as you use your servers.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {user && user.limits.serverLimit > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Account limits</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <UsageMeter
              label="Servers"
              used={data?.servers.total ?? 0}
              limit={user.limits.serverLimit}
              formatValue={(value) => String(value)}
            />
            <UsageMeter
              label="Memory"
              used={(data?.resources.memoryAllocated ?? 0) / 1024 / 1024}
              limit={user.limits.memoryLimit}
              formatValue={(value) => formatMib(value, 0)}
            />
            <UsageMeter
              label="Disk"
              used={(data?.resources.diskAllocated ?? 0) / 1024 / 1024}
              limit={user.limits.diskLimit}
              formatValue={(value) => formatMib(value, 0)}
            />
            <UsageMeter
              label="Backups per server"
              used={0}
              limit={user.limits.backupLimit}
              formatValue={(value) => String(value)}
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
