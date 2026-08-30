'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Copy, Loader2 } from 'lucide-react';
import { Badge, Button, Card, ScrollArea, cn, useToast } from '@storm/ui';
import { SERVER_TABS } from '@/components/panel/sidebar';
import { ServerProvider, useServerQuery } from '@/components/panel/server-context';
import { ServerStatusBadge } from '@/components/panel/stats';
import { PowerControls } from '@/components/panel/power-controls';
import { useAccountSocket } from '@/hooks/use-account-socket';
import { errorMessage } from '@/lib/api';

export default function ServerLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const toast = useToast();
  const { servers: live } = useAccountSocket();

  const { data: server, isLoading, error, refetch } = useServerQuery(params.id);

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !server) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10">
          <AlertTriangle className="h-5 w-5 text-destructive" />
        </div>
        <h1 className="text-lg font-semibold">Server unavailable</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {error ? errorMessage(error) : 'This server does not exist or you do not have access to it.'}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
          <Button asChild>
            <Link href="/servers">Back to servers</Link>
          </Button>
        </div>
      </Card>
    );
  }

  const status = live[server.id]?.status ?? server.status;
  const base = `/servers/${params.id}`;
  const address = server.primaryAllocation
    ? `${server.primaryAllocation.ip}:${server.primaryAllocation.port}`
    : null;

  const copyAddress = async (): Promise<void> => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast.success('Address copied', address);
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  };

  return (
    <ServerProvider server={server}>
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="space-y-4">
          <Link
            href="/servers"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            All servers
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{server.name}</h1>
                <ServerStatusBadge status={status} />
                {server.suspended ? <Badge variant="destructive">Suspended</Badge> : null}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="font-mono text-xs">{server.shortId}</span>
                {address ? (
                  <button
                    type="button"
                    onClick={() => void copyAddress()}
                    className="inline-flex items-center gap-1.5 font-mono text-xs transition-colors hover:text-foreground"
                  >
                    {address}
                    <Copy className="h-3 w-3" />
                  </button>
                ) : null}
                <span className="text-xs">
                  {server.node.name} · {server.template?.game ?? 'Custom'}
                </span>
              </div>
            </div>

            <PowerControls
              serverId={server.id}
              status={status}
              can={(...permissions) =>
                permissions.some((permission) => server.permissions.includes(permission as never))
              }
              size="sm"
            />
          </div>
        </div>

        {server.suspended ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This server is suspended. It cannot be started and customer actions are disabled until
              an administrator restores it.
            </p>
          </div>
        ) : null}

        <ScrollArea className="w-full border-b border-border">
          <nav className="flex min-w-max gap-1 pb-px" aria-label="Server sections">
            {SERVER_TABS.map((tab) => {
              const href = tab.segment ? `${base}/${tab.segment}` : base;
              const active = tab.segment ? pathname.startsWith(href) : pathname === base;
              return (
                <Link
                  key={tab.segment || 'overview'}
                  href={href}
                  className={cn(
                    'relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-current={active ? 'page' : undefined}
                >
                  <tab.icon className="h-3.5 w-3.5" />
                  {tab.label}
                  {active ? (
                    <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </ScrollArea>

        <div className="animate-fade-in">{children}</div>
      </div>
    </ServerProvider>
  );
}
