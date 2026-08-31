'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Server,
  Users,
} from 'lucide-react';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@storm/ui';
import type { AdminOverview } from '@storm/types';
import { api } from '@/lib/api';
import { formatBytes, formatPercent, formatRelative, humaniseEvent } from '@/lib/format';
import { StatCard, UsageMeter } from '@/components/panel/stats';

export default function AdminOverviewPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api.get<AdminOverview>('/admin/overview'),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="text-sm text-muted-foreground">Fleet-wide health and recent activity.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Users"
          value={data?.users.total ?? 0}
          hint={`${data?.users.online ?? 0} active now`}
          icon={Users}
          loading={isLoading}
        />
        <StatCard
          label="Servers"
          value={data?.servers.total ?? 0}
          hint={`${data?.servers.online ?? 0} online`}
          icon={Server}
          loading={isLoading}
        />
        <StatCard
          label="Nodes online"
          value={`${data?.nodes.online ?? 0}/${data?.nodes.total ?? 0}`}
          hint={
            data && data.nodes.offline > 0 ? `${data.nodes.offline} offline` : 'All nodes reporting'
          }
          icon={Network}
          tone={data && data.nodes.offline > 0 ? 'destructive' : 'success'}
          loading={isLoading}
        />
        <StatCard
          label="Fleet CPU"
          value={formatPercent(data?.resources.cpuPercent ?? 0)}
          hint="Average across online nodes"
          icon={Cpu}
          loading={isLoading}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Capacity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <UsageMeter
              label="Memory"
              icon={MemoryStick}
              used={data?.resources.memoryUsed ?? 0}
              limit={data?.resources.memoryTotal ?? 0}
              formatValue={(value) => formatBytes(value, 0)}
            />
            <UsageMeter
              label="Disk"
              icon={HardDrive}
              used={data?.resources.diskUsed ?? 0}
              limit={data?.resources.diskTotal ?? 0}
              formatValue={(value) => formatBytes(value, 0)}
            />
            <div className="flex items-center justify-between border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">Network</span>
              <span className="font-medium tabular-nums">
                ↓ {formatBytes(data?.resources.networkRx ?? 0)} · ↑{' '}
                {formatBytes(data?.resources.networkTx ?? 0)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>Recent events</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/audit">
                Audit log
                <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2, 3, 4].map((key) => (
                  <Skeleton key={key} className="h-10" />
                ))}
              </div>
            ) : data?.recentEvents.length ? (
              <ul className="space-y-2.5">
                {data.recentEvents.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 text-sm">
                    <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">
                        {humaniseEvent(event.action)}
                        {event.targetLabel ? (
                          <span className="text-muted-foreground"> · {event.targetLabel}</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {event.actor?.username ?? 'system'} · {formatRelative(event.createdAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">No events recorded.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          title="Server states"
          rows={[
            ['Online', data?.servers.online ?? 0, 'success'],
            ['Offline', data?.servers.offline ?? 0, 'muted'],
            ['Suspended', data?.servers.suspended ?? 0, 'destructive'],
          ]}
        />
        <SummaryCard
          title="Node states"
          rows={[
            ['Online', data?.nodes.online ?? 0, 'success'],
            ['Degraded', data?.nodes.degraded ?? 0, 'warning'],
            ['Offline', data?.nodes.offline ?? 0, 'destructive'],
            ['Maintenance', data?.nodes.maintenance ?? 0, 'muted'],
          ]}
        />
        <SummaryCard
          title="Users"
          rows={[
            ['Total', data?.users.total ?? 0, 'default'],
            ['New this week', data?.users.newThisWeek ?? 0, 'success'],
            ['Suspended', data?.users.suspended ?? 0, 'destructive'],
          ]}
        />
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Quick links
          </p>
          <div className="mt-3 grid gap-1.5">
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/nodes">Manage nodes</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/users">Manage users</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/templates">Game templates</Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  rows,
}: {
  title: string;
  rows: [string, number, 'success' | 'warning' | 'destructive' | 'muted' | 'default'][];
}) {
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-3 space-y-2">
        {rows.map(([label, value, tone]) => (
          <div key={label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{label}</span>
            <Badge variant={tone}>{value}</Badge>
          </div>
        ))}
      </div>
    </Card>
  );
}
