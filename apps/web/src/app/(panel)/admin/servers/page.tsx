'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Search, Server } from 'lucide-react';
import {
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
} from '@storm/ui';
import type { ServerSummary } from '@storm/types';
import { apiPaginated } from '@/lib/api';
import { formatMib, formatRelative } from '@/lib/format';
import { ServerStatusBadge } from '@/components/panel/stats';

const STATUSES = ['all', 'ONLINE', 'OFFLINE', 'CRASHED', 'SUSPENDED', 'INSTALLING'];

export default function AdminServersPage() {
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const perPage = 25;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'servers', debounced, status, page],
    queryFn: () =>
      apiPaginated<ServerSummary>('/admin/servers', {
        query: {
          page,
          perPage,
          search: debounced || undefined,
          status: status === 'all' ? undefined : status,
        },
      }),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">All servers</h1>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.meta.total} server${data.meta.total === 1 ? '' : 's'} across the fleet` : 'Loading…'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by server, ID or owner…"
            className="pl-9"
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
            {STATUSES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry === 'all' ? 'All statuses' : entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="h-12" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Server</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead className="w-40">Owner</TableHead>
                <TableHead className="w-36">Node</TableHead>
                <TableHead className="w-40">Resources</TableHead>
                <TableHead className="w-32">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((server) => (
                <TableRow key={server.id} interactive>
                  <TableCell>
                    <Link href={`/servers/${server.shortId}`} className="block">
                      <span className="block font-medium">{server.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {server.shortId} · {server.template?.game ?? 'Custom'}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ServerStatusBadge status={server.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="block truncate">{server.owner?.username ?? '—'}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {server.owner?.email}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="block">{server.node.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {server.node.location}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatMib(server.limits.memoryLimit, 0)} RAM
                    <br />
                    {formatMib(server.limits.diskLimit, 0)} disk
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(server.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={Server} title="No servers match" />
        )}
      </Card>

      {data ? (
        <Pagination page={page} perPage={perPage} total={data.meta.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
