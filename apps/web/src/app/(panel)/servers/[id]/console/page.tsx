'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@storm/ui';
import { formatBytes, formatPercent, formatUptime } from '@/lib/format';
import { ServerConsole } from '@/components/panel/console';
import { PowerControls } from '@/components/panel/power-controls';
import { useServer } from '@/components/panel/server-context';
import { useServerSocket } from '@/hooks/use-server-socket';

export default function ConsolePage() {
  const { server, can, status: contextStatus, setLiveStatus } = useServer();
  const socket = useServerSocket(server.id);

  // Keep the header badge in step with what the console is seeing.
  React.useEffect(() => {
    if (socket.status) setLiveStatus(socket.status);
  }, [socket.status, setLiveStatus]);

  const status = socket.status ?? contextStatus;
  const stats = socket.stats;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
      <ServerConsole
        lines={socket.lines}
        state={socket.state}
        status={status}
        canSendCommands={can('servers.command') && !server.suspended}
        onCommand={(command) => socket.send({ type: 'command', command })}
        onClear={socket.clear}
        serverName={server.name}
        className="h-[calc(100vh-19rem)] min-h-[420px]"
      />

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Power</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2 [&>div]:flex-col [&>div]:items-stretch [&_button]:w-full">
              <PowerControls
                serverId={server.id}
                status={status}
                can={can}
                size="sm"
                onAction={(action) => {
                  if (action === 'start' || action === 'restart') setLiveStatus('STARTING');
                  if (action === 'stop') setLiveStatus('STOPPING');
                  if (action === 'kill') setLiveStatus('OFFLINE');
                }}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Live usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5 text-sm">
            <Row label="CPU" value={stats ? formatPercent(stats.cpuPercent) : '—'} />
            <Row label="Memory" value={stats ? formatBytes(stats.memoryBytes) : '—'} />
            <Row label="Disk" value={stats ? formatBytes(stats.diskBytes) : '—'} />
            <Row label="Network in" value={stats ? formatBytes(stats.networkRx) : '—'} />
            <Row label="Network out" value={stats ? formatBytes(stats.networkTx) : '—'} />
            <Row
              label="Uptime"
              value={stats && status === 'ONLINE' ? formatUptime(stats.uptime) : '—'}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
