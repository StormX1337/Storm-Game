'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Shield } from 'lucide-react';
import {
  Badge,
  Card,
  EmptyState,
  Input,
  Pagination,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@storm/ui';
import type { AuditLogView } from '@storm/types';
import { apiPaginated } from '@/lib/api';
import { formatDate, formatRelative, humaniseEvent } from '@/lib/format';

export default function AuditLogPage() {
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [page, setPage] = React.useState(1);
  const perPage = 30;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'audit', debounced, page],
    queryFn: () =>
      apiPaginated<AuditLogView>('/admin/audit', {
        query: { page, perPage, search: debounced || undefined },
      }),
  });

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every privileged action taken in the panel, newest first.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by action, target, user or IP…"
          className="pl-9"
        />
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <Skeleton key={key} className="h-11" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead className="w-40">Actor</TableHead>
                <TableHead className="w-48">Target</TableHead>
                <TableHead className="w-32">IP</TableHead>
                <TableHead className="w-44">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <span className="block font-medium">{humaniseEvent(entry.action)}</span>
                    <span className="block font-mono text-2xs text-muted-foreground">
                      {entry.action}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.actor?.username ?? <Badge variant="muted">system</Badge>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {entry.targetLabel ? (
                      <>
                        <span className="block truncate">{entry.targetLabel}</span>
                        <span className="block text-2xs text-muted-foreground">
                          {entry.targetType}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {entry.ip ?? '—'}
                  </TableCell>
                  <TableCell>
                    <span className="block text-sm">{formatRelative(entry.createdAt)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDate(entry.createdAt)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={Shield}
            title="No audit entries"
            description="Privileged actions will be recorded here as they happen."
          />
        )}
      </Card>

      {data ? (
        <Pagination page={page} perPage={perPage} total={data.meta.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
