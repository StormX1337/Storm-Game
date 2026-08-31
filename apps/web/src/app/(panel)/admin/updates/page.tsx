'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  GitCommitHorizontal,
  Info,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';

interface UpdateCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: string;
  url: string;
}

interface UpdateJob {
  id: string;
  state: 'requested' | 'running' | 'succeeded' | 'failed';
  requestedCommit: string;
  requestedBy: string;
  requestedAt: string;
  finishedAt?: string;
  message?: string;
}

interface UpdateStatus {
  current: { version: string; commit: string; shortCommit: string; builtAt: string | null };
  available: {
    checked: boolean;
    comparable: boolean;
    upToDate: boolean;
    commit: string | null;
    shortCommit: string | null;
    behindBy: number;
    commits: UpdateCommit[];
  };
  canApply: boolean;
  reason: string | null;
  repository: string;
  branch: string;
  lastCheckedAt: string | null;
  job: UpdateJob | null;
}

export default function UpdatesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['admin', 'updates'],
    queryFn: () => api.get<UpdateStatus>('/admin/updates'),
    // While an update runs the panel itself restarts underneath us, so poll
    // briskly and expect a few failed requests along the way.
    refetchInterval: (query) => {
      const state = query.state.data?.job?.state;
      return state === 'requested' || state === 'running' ? 5_000 : false;
    },
  });

  const apply = useMutation({
    mutationFn: (commit: string) => api.post<UpdateJob>('/admin/updates/apply', { commit }),
    onSuccess: () => {
      toast.info('Update requested', 'The host is applying it. The panel will restart shortly.');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'updates'] });
    },
    onError: (error) => toast.error('Could not start the update', errorMessage(error)),
  });

  const data = status.data;
  const running = data?.job?.state === 'requested' || data?.job?.state === 'running';

  async function onApply(): Promise<void> {
    if (!data?.available.commit) return;

    const confirmed = await confirm({
      title: `Update to ${data.available.shortCommit}?`,
      description:
        `${data.available.behindBy} change${data.available.behindBy === 1 ? '' : 's'} will be applied. ` +
        'The host backs up the database first, then rebuilds and restarts the panel — it is unreachable for a minute or two. ' +
        'Game servers keep running throughout.',
      confirmLabel: 'Update now',
    });

    if (confirmed) apply.mutate(data.available.commit);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Updates</h1>
          <p className="text-sm text-muted-foreground">
            What this panel is running, and what is available.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void status.refetch()}
          loading={status.isFetching}
        >
          <RefreshCw />
          Check again
        </Button>
      </div>

      {status.isLoading ? (
        <Skeleton className="h-48" />
      ) : !data ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            The update status could not be loaded.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {data.available.upToDate ? (
                  <>
                    <CheckCircle2 className="h-5 w-5 text-success" />
                    Up to date
                  </>
                ) : !data.available.comparable ? (
                  /* An unstamped image is not "behind" — it is unknown. Saying
                     "Update available" here offers an update the panel has no
                     way to know is needed, and goes on offering it after one
                     has been applied. */
                  <>
                    <Info className="h-5 w-5 text-muted-foreground" />
                    Version unknown
                  </>
                ) : data.available.checked ? (
                  <>
                    <Download className="h-5 w-5 text-primary" />
                    Update available
                  </>
                ) : (
                  <>
                    <Info className="h-5 w-5 text-muted-foreground" />
                    Version
                  </>
                )}
              </CardTitle>
              <CardDescription>
                Tracking{' '}
                <span className="font-mono">
                  {data.repository}@{data.branch}
                </span>
                {data.lastCheckedAt ? <> · checked {formatRelative(data.lastCheckedAt)}</> : null}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Version
                  label="Running"
                  version={data.current.version}
                  commit={data.current.shortCommit}
                  detail={data.current.builtAt ? `built ${formatDate(data.current.builtAt)}` : null}
                />

                {!data.available.upToDate &&
                data.available.comparable &&
                data.available.shortCommit ? (
                  <>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <Version
                      label="Available"
                      version={data.current.version}
                      commit={data.available.shortCommit}
                      detail={`${data.available.behindBy} change${data.available.behindBy === 1 ? '' : 's'} behind`}
                      highlight
                    />
                  </>
                ) : null}
              </div>

              {running ? (
                <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
                  <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                  <div>
                    <p className="font-medium">Update in progress</p>
                    <p className="text-muted-foreground">
                      Requested by {data.job?.requestedBy} {formatRelative(data.job?.requestedAt)}.
                      The panel restarts when it finishes — this page may briefly fail to load.
                    </p>
                  </div>
                </div>
              ) : data.job?.state === 'failed' ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <div>
                    <p className="font-medium text-destructive">The last update failed</p>
                    <p className="break-words text-muted-foreground">{data.job.message}</p>
                    <p className="mt-1 text-muted-foreground">
                      The previous version is still running. Check{' '}
                      <code className="font-mono text-xs">journalctl -u storm-updater</code> on the
                      host.
                    </p>
                  </div>
                </div>
              ) : data.job?.state === 'succeeded' && data.available.upToDate ? (
                <p className="text-sm text-muted-foreground">
                  Last updated {formatRelative(data.job.finishedAt ?? data.job.requestedAt)} by{' '}
                  {data.job.requestedBy}.
                </p>
              ) : null}

              {/*
                While one is running, canApply is false and its reason is "an
                update is already in progress" — which the panel would otherwise
                render next to an invitation to go start one on the host. The
                banner above already says what is happening; a second copy that
                advises a colliding run does not help.
              */}
              {!data.available.upToDate &&
              data.available.comparable &&
              data.available.checked &&
              !running ? (
                data.canApply ? (
                  <Button
                    onClick={() => void onApply()}
                    loading={apply.isPending}
                    disabled={running}
                  >
                    <Download />
                    Update now
                  </Button>
                ) : (
                  <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
                    <p className="flex items-start gap-2">
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span>{data.reason}</span>
                    </p>
                    <p className="text-muted-foreground">
                      Update from the host instead, in your Storm Panel checkout:
                    </p>
                    <code className="block break-all rounded bg-background p-2 font-mono text-xs">
                      ./scripts/update.sh
                    </code>
                  </div>
                )
              ) : null}

              {!data.available.comparable && data.reason ? (
                <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3 text-sm">
                  <p className="flex items-start gap-2">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span>{data.reason}</span>
                  </p>
                  <p className="text-muted-foreground">
                    Rebuild from the host and it will report its version again:
                  </p>
                  <code className="block break-all rounded bg-background p-2 font-mono text-xs">
                    ./scripts/update.sh
                  </code>
                </div>
              ) : !data.available.checked && data.reason ? (
                <p className="text-sm text-muted-foreground">{data.reason}</p>
              ) : null}
            </CardContent>
          </Card>

          {data.available.commits.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">What changes</CardTitle>
                <CardDescription>
                  {data.available.behindBy} commit{data.available.behindBy === 1 ? '' : 's'} since
                  this panel was built.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {data.available.commits.map((commit) => (
                  <a
                    key={commit.sha}
                    href={commit.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/50"
                  >
                    <GitCommitHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium">{commit.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {commit.author} · {formatRelative(commit.committedAt)}
                      </p>
                    </div>
                    <Badge variant="muted" className="shrink-0 font-mono text-2xs">
                      {commit.shortSha}
                    </Badge>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  </a>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">How updating works here</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The panel cannot update itself. It has no access to Docker or to the host&apos;s
                checkout, on purpose — a hole in a web endpoint must not become root on the machine
                that runs every customer&apos;s server.
              </p>
              <p>
                Pressing the button writes a request into a directory the host watches. A service
                running on the host reads it, backs up the database, rebuilds and restarts. It
                accepts only the exact version this page offered, and nothing else.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Version({
  label,
  version,
  commit,
  detail,
  highlight,
}: {
  label: string;
  version: string;
  commit: string;
  detail: string | null;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlight ? 'border-primary/50 bg-primary/5' : 'border-border bg-secondary/40'
      }`}
    >
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="flex items-baseline gap-2">
        <span className="text-lg font-semibold">v{version}</span>
        <code className="font-mono text-xs text-muted-foreground">{commit}</code>
      </p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}
