'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Pagination, Skeleton, cn, useToast } from '@storm/ui';
import type { NotificationView } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';

interface NotificationsPayload {
  items: NotificationView[];
  unread: number;
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

const LEVEL_DOT: Record<string, string> = {
  ERROR: 'bg-destructive',
  WARNING: 'bg-warning',
  SUCCESS: 'bg-success',
  INFO: 'bg-primary',
};

export default function NotificationsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const perPage = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'page', page],
    queryFn: () =>
      api.get<NotificationsPayload>('/account/notifications', { query: { page, perPage } }),
  });

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.post('/account/notifications/read', ids ? { ids } : {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.error('Could not update notifications', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/account/notifications/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (error) => toast.error('Could not delete notification', errorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Notifications</h2>
          <p className="text-sm text-muted-foreground">
            {data?.unread ? `${data.unread} unread` : 'You are all caught up'}
          </p>
        </div>
        {data?.unread ? (
          <Button variant="outline" size="sm" onClick={() => markRead.mutate(undefined)}>
            <CheckCheck />
            Mark all read
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-16" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="space-y-2">
          {data.items.map((notification) => (
            <Card
              key={notification.id}
              className={cn(
                'p-4 transition-colors',
                !notification.read && 'border-primary/30 bg-primary/[0.03]',
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    LEVEL_DOT[notification.level] ?? 'bg-muted-foreground',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{notification.title}</p>
                    {!notification.read ? <Badge variant="default">New</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">{notification.message}</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {formatRelative(notification.createdAt)} · {formatDate(notification.createdAt)}
                  </p>
                  {notification.link ? (
                    <Link
                      href={notification.link}
                      className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline"
                      onClick={() => markRead.mutate([notification.id])}
                    >
                      Open
                    </Link>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={() => remove.mutate(notification.id)}
                  aria-label="Delete notification"
                >
                  <Trash2 />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={Bell}
            title="No notifications"
            description="Alerts about your servers, backups and account will appear here."
          />
        </Card>
      )}

      {data && data.items.length > 0 ? (
        <Pagination page={page} perPage={perPage} total={data.total} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
