'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { LayoutGrid, List, Plus, Search, Server } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@storm/ui';
import type { ServerSummary } from '@storm/types';
import { apiPaginated } from '@/lib/api';
import { formatMib, formatRelative } from '@/lib/format';
import { ServerCard } from '@/components/panel/server-card';
import { ServerStatusBadge } from '@/components/panel/stats';
import { useAccountSocket } from '@/hooks/use-account-socket';

const STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'ONLINE', label: 'Online' },
  { value: 'OFFLINE', label: 'Offline' },
  { value: 'STARTING', label: 'Starting' },
  { value: 'CRASHED', label: 'Crashed' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'INSTALLING', label: 'Installing' },
];

export default function ServersPage() {
  const [view, setView] = React.useState<'grid' | 'table'>('grid');
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const perPage = 12;

  // Debounced so typing does not fire a request per keystroke.
  const [debounced, setDebounced] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['servers', 'list', debounced, status, page],
    queryFn: () =>
      apiPaginated<ServerSummary>('/servers', {
        query: {
          page,
          perPage,
          search: debounced || undefined,
          status: status === 'all' ? undefined : status,
        },
      }),
  });

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Servers</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.meta.total} server${data.meta.total === 1 ? '' : 's'}` : 'Loading…'}
          </p>
        </div>
        <Button asChild>
          <Link href="/servers/new">
            <Plus />
            Create server
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or ID…"
            className="pl-9"
            aria-label="Search servers"
          />
        </div>

        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex rounded-lg border border-border p-0.5">
          <button
            type="button"
            onClick={() => setView('grid')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              view === 'grid' ? 'bg-secondary text-foreground' : 'text-muted-foreground',
            )}
            aria-label="Grid view"
            aria-pressed={view === 'grid'}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setView('table')}
            className={cn(
              'rounded-md p-1.5 transition-colors',
              view === 'table' ? 'bg-secondary text-foreground' : 'text-muted-foreground',
            )}
            aria-label="Table view"
            aria-pressed={view === 'table'}
          >
            <List className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Skeleton key={key} className="h-44" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          {view === 'grid' ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.items.map((server) => (
                <ServerCard key={server.id} server={server} />
              ))}
            </div>
          ) : (
            <Card>
              <ServerTable servers={data.items} />
            </Card>
          )}
          <Pagination
            page={page}
            perPage={perPage}
            total={data.meta.total}
            onPageChange={setPage}
          />
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Server}
            title={debounced || status !== 'all' ? 'No matching servers' : 'No servers yet'}
            description={
              debounced || status !== 'all'
                ? 'Try a different search term or clear the status filter.'
                : 'Create your first server to get started.'
            }
            action={
              debounced || status !== 'all' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch('');
                    setStatus('all');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button asChild size="sm">
                  <Link href="/servers/new">
                    <Plus />
                    Create server
                  </Link>
                </Button>
              )
            }
          />
        </Card>
      )}
    </div>
  );
}

function ServerTable({ servers }: { servers: ServerSummary[] }) {
  const { servers: live } = useAccountSocket();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Server</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Node</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Resources</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {servers.map((server) => {
          const status = live[server.id]?.status ?? server.status;
          return (
            <TableRow key={server.id} interactive>
              <TableCell>
                <Link href={`/servers/${server.shortId}`} className="block">
                  <span className="block font-medium">{server.name}</span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {server.shortId}
                  </span>
                </Link>
              </TableCell>
              <TableCell>
                <ServerStatusBadge status={status} />
              </TableCell>
              <TableCell>
                <span className="block text-sm">{server.node.name}</span>
                <span className="block text-xs text-muted-foreground">{server.node.location}</span>
              </TableCell>
              <TableCell className="font-mono text-xs">
                {server.primaryAllocation
                  ? `${server.primaryAllocation.ip}:${server.primaryAllocation.port}`
                  : '—'}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatMib(server.limits.memoryLimit, 0)} RAM ·{' '}
                {formatMib(server.limits.diskLimit, 0)} disk
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatRelative(server.createdAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
