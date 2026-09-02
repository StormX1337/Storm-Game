'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ListChecks, RotateCw, Trash2, WifiOff } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  cn,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface QueueRow {
  key: string;
  label: string;
  reachable: boolean;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

interface FailedJob {
  id: string;
  name: string;
  attempts: number;
  reason: string;
  data: unknown;
  createdAt: string | null;
  failedAt: string | null;
}

/**
 * The work the panel does out of sight.
 *
 * Installs, backups, restores, transfers, webhook deliveries, mail and
 * scheduled tasks all run through queues. A job that fails retries a few
 * times, gives up, and sits in Redis for a week — and until this page there
 * was nothing anywhere in the panel that could see it. The first anyone knew
 * was a customer asking where their backup had gone.
 */
export default function AdminJobsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState<string | null>(null);

  const queues = useQuery({
    queryKey: ['admin', 'jobs'],
    queryFn: () => api.get<QueueRow[]>('/admin/jobs'),
    // Counts move on their own. Often enough to watch a queue drain, rarely
    // enough not to hammer Redis from every open admin tab.
    refetchInterval: 10_000,
  });

  const failed = useQuery({
    queryKey: ['admin', 'jobs', open, 'failed'],
    queryFn: () => api.get<FailedJob[]>(`/admin/jobs/${open}/failed`),
    enabled: open !== null,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] });
  };

  const retry = useMutation({
    mutationFn: ({ queue, jobId }: { queue: string; jobId: string }) =>
      api.post<{ message: string }>(`/admin/jobs/${queue}/${encodeURIComponent(jobId)}/retry`, {}),
    onSuccess: (result) => {
      toast.success('Job queued again', result.message);
      refresh();
    },
    onError: (error) => toast.error('Could not retry that job', errorMessage(error)),
  });

  const discard = useMutation({
    mutationFn: ({ queue, jobId }: { queue: string; jobId: string }) =>
      api.delete(`/admin/jobs/${queue}/${encodeURIComponent(jobId)}`),
    onSuccess: () => {
      toast.success('Job discarded');
      refresh();
    },
    onError: (error) => toast.error('Could not discard that job', errorMessage(error)),
  });

  const askDiscard = async (queue: string, job: FailedJob): Promise<void> => {
    const confirmed = await confirm({
      title: `Discard ${job.name}?`,
      description:
        'The job is removed from the queue and will not run. Whatever it was going to do stays undone — a backup that was never taken, an email that was never sent.',
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (confirmed) discard.mutate({ queue, jobId: job.id });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Background jobs</h1>
        <p className="text-sm text-muted-foreground">
          Installs, backups, transfers, webhooks, mail and schedules, and what has gone wrong with
          them.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {queues.isLoading
          ? [0, 1, 2, 3, 4, 5].map((key) => <Skeleton key={key} className="h-32" />)
          : queues.data?.map((queue) => (
              <Card
                key={queue.key}
                className={cn(
                  'storm-interactive cursor-pointer p-4',
                  open === queue.key && 'border-primary/50',
                  queue.failed > 0 && 'border-destructive/40',
                )}
                role="button"
                tabIndex={0}
                aria-pressed={open === queue.key}
                onClick={() => setOpen(open === queue.key ? null : queue.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setOpen(open === queue.key ? null : queue.key);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold">{queue.label}</p>
                    <p className="font-mono text-xs text-muted-foreground">{queue.key}</p>
                  </div>
                  {!queue.reachable ? (
                    <Badge variant="destructive">
                      <WifiOff className="h-3 w-3" />
                      unreachable
                    </Badge>
                  ) : queue.failed > 0 ? (
                    <Badge variant="destructive">{queue.failed} failed</Badge>
                  ) : (
                    <Badge variant="success">
                      <CheckCircle2 className="h-3 w-3" />
                      healthy
                    </Badge>
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                  {(
                    [
                      ['Active', queue.active],
                      ['Waiting', queue.waiting],
                      ['Delayed', queue.delayed],
                      ['Done', queue.completed],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            ))}
      </div>

      {open ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Failed · {queues.data?.find((queue) => queue.key === open)?.label ?? open}
            </CardTitle>
            <CardDescription>
              Newest first. Retrying puts a job back on the queue as it was; discarding leaves
              whatever it was going to do undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {failed.isLoading ? (
              <Skeleton className="h-32" />
            ) : (failed.data?.length ?? 0) === 0 ? (
              <EmptyState icon={ListChecks} title="Nothing has failed in this queue" />
            ) : (
              <ul className="divide-y divide-border">
                {failed.data?.map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {job.name}
                        <Badge variant="muted">
                          {job.attempts} attempt{job.attempts === 1 ? '' : 's'}
                        </Badge>
                      </p>
                      <p className="break-words text-sm text-destructive">
                        {job.reason || 'No reason recorded'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {job.failedAt ? `failed ${formatRelative(job.failedAt)}` : 'not yet failed'}
                        {' · '}
                        <span className="font-mono">{job.id}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={retry.isPending}
                        onClick={() => retry.mutate({ queue: open, jobId: job.id })}
                      >
                        <RotateCw />
                        Retry
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => void askDiscard(open, job)}
                      >
                        <Trash2 />
                        Discard
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
