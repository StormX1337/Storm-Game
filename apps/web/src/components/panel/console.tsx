'use client';

import * as React from 'react';
import {
  ArrowDown,
  ChevronRight,
  Download,
  Eraser,
  Search,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Button, Card, Input, cn, useToast } from '@storm/ui';
import type { ServerStatus } from '@storm/types';
import type { ConsoleLine, SocketState } from '@/hooks/use-server-socket';

/**
 * ANSI SGR renderer.
 *
 * Game servers colour their output, and stripping it loses information a
 * console operator relies on (warnings, errors, chat). Only colour and the
 * bold/dim/underline attributes are honoured — cursor movement and screen
 * clearing are dropped, since this is a log view, not a terminal emulator.
 */
const ANSI_PATTERN = /\x1b\[([0-9;]*)m/g;
// eslint-disable-next-line no-control-regex -- deliberately matching control sequences
const ANSI_STRIP = /\x1b\[[0-9;?]*[a-zA-Z]/g;

const FOREGROUND: Record<number, string> = {
  30: '#5c6370',
  31: '#e06c75',
  32: '#98c379',
  33: '#e5c07b',
  34: '#61afef',
  35: '#c678dd',
  36: '#56b6c2',
  37: '#dcdfe4',
  90: '#7f848e',
  91: '#f28b82',
  92: '#b5e08a',
  93: '#ffd479',
  94: '#82c0ff',
  95: '#dda0ee',
  96: '#7fd4dd',
  97: '#ffffff',
};

interface Segment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

function parseAnsi(input: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  let current: Omit<Segment, 'text'> = {};

  ANSI_PATTERN.lastIndex = 0;
  let match = ANSI_PATTERN.exec(input);

  while (match !== null) {
    if (match.index > cursor) {
      segments.push({ ...current, text: input.slice(cursor, match.index) });
    }

    const codes = (match[1] ?? '').split(';').filter(Boolean).map(Number);
    if (codes.length === 0) current = {};

    for (const code of codes) {
      if (code === 0) current = {};
      else if (code === 1) current = { ...current, bold: true };
      else if (code === 2) current = { ...current, dim: true };
      else if (code === 4) current = { ...current, underline: true };
      else if (code === 22) current = { ...current, bold: false, dim: false };
      else if (code === 24) current = { ...current, underline: false };
      else if (code === 39) current = { ...current, color: undefined };
      else if (FOREGROUND[code]) current = { ...current, color: FOREGROUND[code] };
    }

    cursor = match.index + match[0].length;
    match = ANSI_PATTERN.exec(input);
  }

  if (cursor < input.length) {
    segments.push({ ...current, text: input.slice(cursor) });
  }
  // Drop any remaining non-colour escapes so they never render as mojibake.
  return segments.map((segment) => ({ ...segment, text: segment.text.replace(ANSI_STRIP, '') }));
}

export function ServerConsole({
  lines,
  state,
  status,
  canSendCommands,
  onCommand,
  onClear,
  serverName,
  className,
}: {
  lines: ConsoleLine[];
  state: SocketState;
  status: ServerStatus | null;
  canSendCommands: boolean;
  onCommand: (command: string) => void;
  onClear: () => void;
  serverName: string;
  className?: string;
}) {
  const toast = useToast();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [command, setCommand] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [showFilter, setShowFilter] = React.useState(false);
  const [showTimestamps, setShowTimestamps] = React.useState(false);

  // Command history, navigated with the arrow keys like a real shell.
  const historyRef = React.useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);

  const visible = React.useMemo(() => {
    if (!filter.trim()) return lines;
    const needle = filter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, filter]);

  React.useEffect(() => {
    if (!autoScroll) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visible, autoScroll]);

  const onScroll = (): void => {
    const element = scrollRef.current;
    if (!element) return;
    // Re-arm auto-scroll only when the user is genuinely back at the bottom.
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const value = command.trim();
    if (!value) return;

    onCommand(value);
    historyRef.current = [...historyRef.current.filter((entry) => entry !== value), value].slice(-50);
    setHistoryIndex(-1);
    setCommand('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const history = historyRef.current;
      if (history.length === 0) return;
      const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      setCommand(history[next] ?? '');
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const history = historyRef.current;
      if (historyIndex < 0) return;
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        setCommand('');
      } else {
        setHistoryIndex(next);
        setCommand(history[next] ?? '');
      }
    }
  };

  const download = (): void => {
    const body = lines
      .map((line) => `[${new Date(line.at).toISOString()}] ${line.text.replace(ANSI_STRIP, '')}`)
      .join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${serverName.replace(/[^\w.-]+/g, '_')}-console.log`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('Log downloaded', `${lines.length} lines saved.`);
  };

  const running = status === 'ONLINE' || status === 'STARTING';

  return (
    <Card className={cn('flex flex-col overflow-hidden', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium',
            state === 'open'
              ? 'border-success/40 text-success'
              : state === 'connecting'
                ? 'border-warning/40 text-warning'
                : 'border-destructive/40 text-destructive',
          )}
        >
          {state === 'open' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {state === 'open' ? 'Connected' : state === 'connecting' ? 'Connecting' : 'Disconnected'}
        </span>

        <span className="text-2xs text-muted-foreground">
          {visible.length} line{visible.length === 1 ? '' : 's'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          {showFilter ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter output…"
              className="h-7 w-44 text-xs"
              autoFocus
              onBlur={() => !filter && setShowFilter(false)}
            />
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowFilter(true)}
              aria-label="Search console output"
            >
              <Search />
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTimestamps((current) => !current)}
            className={cn('text-xs', showTimestamps && 'text-primary')}
          >
            Timestamps
          </Button>

          <Button variant="ghost" size="icon-sm" onClick={download} aria-label="Download log">
            <Download />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear console">
            <Eraser />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto bg-[#0a0c10] px-4 py-3 font-mono text-[12.5px] leading-relaxed"
        >
          {visible.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              {filter ? 'No lines match that filter.' : 'Waiting for server output…'}
            </p>
          ) : (
            visible.map((line) => (
              <div key={line.id} className="flex gap-2 whitespace-pre-wrap break-all">
                {showTimestamps ? (
                  <span className="shrink-0 select-none text-[#4b5263]">
                    {new Date(line.at).toLocaleTimeString()}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'min-w-0',
                    line.kind === 'install' && 'text-[#61afef]',
                    line.kind === 'system' && 'text-[#e5c07b]',
                  )}
                >
                  {line.kind === 'output' ? (
                    parseAnsi(line.text).map((segment, index) => (
                      <span
                        key={index}
                        style={{
                          color: segment.color ?? '#c8ccd4',
                          fontWeight: segment.bold ? 600 : undefined,
                          opacity: segment.dim ? 0.65 : undefined,
                          textDecoration: segment.underline ? 'underline' : undefined,
                        }}
                      >
                        {segment.text}
                      </span>
                    ))
                  ) : (
                    <span>{line.text}</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        {!autoScroll ? (
          <Button
            size="sm"
            className="absolute bottom-3 right-4 shadow-lg"
            onClick={() => {
              setAutoScroll(true);
              const element = scrollRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
          >
            <ArrowDown />
            Jump to latest
          </Button>
        ) : null}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 border-t border-border bg-card p-2.5">
        <ChevronRight className="ml-1 h-4 w-4 shrink-0 text-primary" />
        <Input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            !canSendCommands
              ? 'You do not have permission to send commands'
              : running
                ? 'Type a command and press Enter…'
                : 'Start the server to send commands'
          }
          disabled={!canSendCommands || !running}
          className="border-0 bg-transparent font-mono shadow-none focus-visible:ring-0"
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" size="sm" disabled={!canSendCommands || !running || !command.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}
