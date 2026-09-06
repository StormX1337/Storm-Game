'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@storm/ui';
import { formatBytes, formatPercent, formatUptime } from '@/lib/format';
import { ServerConsole } from '@/components/panel/console';
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

      {/*
        No power card here.

        There was one, holding the same four buttons the page header holds,
        both live, about nine hundred pixels apart on the same screen. It
        existed because only its copy told the page it had pressed anything —
        so that moved onto the header's set, which is on every server page,
        and this one went.
      */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Live usage</CardTitle>
          </CardHeader>
          {/*
            Six em-dashes in a column is not a reading.

            While the server is off there are no samples, and every row said
            so separately — six times, in a card two hundred pixels tall,
            which is more space than the numbers take when they exist. One
            sentence says the same thing and stops pretending to be a table.
          */}
          {stats ? (
            <CardContent className="space-y-2.5 text-sm">
              <Row label="CPU" value={formatPercent(stats.cpuPercent)} />
              <Row label="Memory" value={formatBytes(stats.memoryBytes)} />
              <Row label="Disk" value={formatBytes(stats.diskBytes)} />
              <Row label="Network in" value={formatBytes(stats.networkRx)} />
              <Row label="Network out" value={formatBytes(stats.networkTx)} />
              <Row label="Uptime" value={status === 'ONLINE' ? formatUptime(stats.uptime) : '—'} />
            </CardContent>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                {status === 'ONLINE' || status === 'STARTING'
                  ? 'Waiting for the first sample from the node.'
                  : 'The server reports usage while it is running.'}
              </p>
            </CardContent>
          )}
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
