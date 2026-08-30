'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import {
  Card,
  EmptyState,
  Pagination,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@storm/ui';
import type { ActivityLogView } from '@storm/types';
import { apiPaginated } from '@/lib/api';
import { formatDate, formatRelative, humaniseEvent } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

export default function ServerActivityPage() {
  const { server } = useServer();
  const [page, setPage] = React.useState(1);
  const perPage = 25;

  const { data, isLoading } = useQuery({
    queryKey: ['server', server.shortId, 'activity', page],
    queryFn: () =>
      apiPaginated<ActivityLogView>(`/servers/${server.id}/activity`, {
        query: { page, perPage },
      }),
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Activity</h2>
        <p className="text-sm text-muted-foreground">
          Everything that has happened to this server, newest first.
        </p>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((key) => (
              <Skeleton key={key} className="h-10" />
            ))}
          </div>
        ) : data && data.items.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="w-40">User</TableHead>
                <TableHead className="w-36">IP</TableHead>
                <TableHead className="w-48">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <span className="block font-medium">{humaniseEvent(entry.event)}</span>
                    {Object.keys(entry.metadata).length > 0 ? (
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        {JSON.stringify(entry.metadata)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">{entry.user?.username ?? 'system'}</TableCell>
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
            icon={Activity}
            title="No activity recorded"
            description="Actions taken on this server will show up here."
          />
        )}
      </Card>

      {data ? (
        <Pagination page={page} perPage={perPage} total={data.meta.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
