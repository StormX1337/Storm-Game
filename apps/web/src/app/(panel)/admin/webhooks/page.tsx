'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Copy,
  MoreHorizontal,
  Plus,
  Send,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Label,
  Skeleton,
  Switch,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';

interface WebhookSummary {
  id: string;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  failureCount: number;
  lastStatus: number | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

interface Delivery {
  id: string;
  event: string;
  status: string;
  responseCode: number | null;
  error: string | null;
  attempt: number;
  createdAt: string;
}

interface TestResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  responseBody: string;
  tookMs: number;
}

export default function WebhooksPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [issuedSecret, setIssuedSecret] = React.useState<{ name: string; secret: string } | null>(
    null,
  );
  const [openDeliveries, setOpenDeliveries] = React.useState<string | null>(null);

  const hooks = useQuery({
    queryKey: ['admin', 'webhooks'],
    queryFn: () => api.get<WebhookSummary[]>('/admin/webhooks'),
  });

  const events = useQuery({
    queryKey: ['admin', 'webhooks', 'events'],
    queryFn: () => api.get<string[]>('/admin/webhooks/events'),
    staleTime: Infinity,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'webhooks'] });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/admin/webhooks/${id}`, { isActive }),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error('Could not change the webhook', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/webhooks/${id}`),
    onSuccess: () => {
      toast.success('Webhook deleted');
      void invalidate();
    },
    onError: (error) => toast.error('Could not delete the webhook', errorMessage(error)),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.post<TestResult>(`/admin/webhooks/${id}/test`, {}),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(
          'Delivered',
          `The endpoint answered ${result.status} in ${result.tookMs} ms.`,
        );
      } else {
        // The reason is the whole point of a test — a toast that only says
        // "failed" sends the operator back to the logs.
        toast.error('Not delivered', result.error ?? 'The endpoint did not accept the delivery.');
      }
      void invalidate();
    },
    onError: (error) => toast.error('Could not send the test', errorMessage(error)),
  });

  async function onDelete(hook: WebhookSummary): Promise<void> {
    const confirmed = await confirm({
      title: `Delete ${hook.name}?`,
      description: 'Events stop being delivered immediately and the delivery history is removed.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) remove.mutate(hook.id);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Send panel events to your own systems. Every delivery is signed, so a receiver can tell
            it came from here.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          Add webhook
        </Button>
      </div>

      {hooks.isLoading ? (
        <Skeleton className="h-40" />
      ) : hooks.data && hooks.data.length > 0 ? (
        <div className="space-y-3">
          {hooks.data.map((hook) => (
            <Card key={hook.id}>
              <CardHeader className="flex-row items-start justify-between gap-3 pb-3">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {hook.name}
                    {hook.isActive ? null : <Badge variant="muted">Paused</Badge>}
                    {hook.failureCount > 0 ? (
                      <Badge variant="destructive">
                        {hook.failureCount} failure{hook.failureCount === 1 ? '' : 's'}
                      </Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription className="break-all font-mono text-xs">
                    {hook.url}
                  </CardDescription>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={hook.isActive}
                    onCheckedChange={(isActive) => toggle.mutate({ id: hook.id, isActive })}
                    aria-label={`${hook.isActive ? 'Pause' : 'Resume'} ${hook.name}`}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => test.mutate(hook.id)}
                    loading={test.isPending && test.variables === hook.id}
                  >
                    <Send />
                    Test
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${hook.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() =>
                          setOpenDeliveries(openDeliveries === hook.id ? null : hook.id)
                        }
                      >
                        {openDeliveries === hook.id ? 'Hide deliveries' : 'Recent deliveries'}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => void onDelete(hook)}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>

              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {hook.events.map((event) => (
                    <Badge key={event} variant="secondary" className="font-mono text-2xs">
                      {event}
                    </Badge>
                  ))}
                </div>

                <p className="text-xs text-muted-foreground">
                  {hook.lastDeliveryAt ? (
                    <>
                      Last delivery {formatRelative(hook.lastDeliveryAt)}
                      {hook.lastStatus ? <> · responded {hook.lastStatus}</> : null}
                    </>
                  ) : (
                    'Nothing delivered yet.'
                  )}
                </p>

                {openDeliveries === hook.id ? <Deliveries webhookId={hook.id} /> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Webhook}
          title="No webhooks yet"
          description="Add one to have the panel tell your systems when a server is installed, a backup fails or a node goes offline."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              Add webhook
            </Button>
          }
        />
      )}

      {createOpen ? (
        <CreateDialog
          events={events.data ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            setIssuedSecret(created);
            void invalidate();
          }}
        />
      ) : null}

      {issuedSecret ? (
        <SecretDialog issued={issuedSecret} onClose={() => setIssuedSecret(null)} />
      ) : null}
    </div>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const deliveries = useQuery({
    queryKey: ['admin', 'webhooks', webhookId, 'deliveries'],
    queryFn: () =>
      api.get<Delivery[]>(`/admin/webhooks/${webhookId}/deliveries`, { query: { perPage: 10 } }),
  });

  if (deliveries.isLoading) return <Skeleton className="h-24" />;
  if (!deliveries.data || deliveries.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No deliveries recorded.</p>;
  }

  return (
    <div className="space-y-1 rounded-lg border border-border p-2">
      {deliveries.data.map((delivery) => (
        <div key={delivery.id} className="flex items-start gap-2 rounded px-2 py-1.5 text-sm">
          {delivery.status === 'SUCCESS' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs">{delivery.event}</p>
            {delivery.error ? (
              <p className="break-words text-xs text-destructive">{delivery.error}</p>
            ) : null}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">
            {delivery.responseCode ?? '—'} · {formatRelative(delivery.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateDialog({
  events,
  onClose,
  onCreated,
}: {
  events: string[];
  onClose: () => void;
  onCreated: (created: { name: string; secret: string }) => void;
}) {
  const toast = useToast();
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; name: string; secret: string }>('/admin/webhooks', {
        name: name.trim(),
        url: url.trim(),
        events: [...selected],
      }),
    onSuccess: (created) => onCreated({ name: created.name, secret: created.secret }),
    onError: (error) => {
      const details = (error as { details?: Record<string, string[]> }).details;
      if (details) setFieldErrors(details);
      toast.error('Could not create the webhook', errorMessage(error));
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a webhook</DialogTitle>
          <DialogDescription>
            The panel POSTs a signed JSON body to this URL when one of the chosen events happens.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" error={fieldErrors.name} required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Billing system"
              autoFocus
            />
          </Field>

          <Field
            label="Endpoint URL"
            hint="Must be reachable from the panel. Private and loopback addresses are refused."
            error={fieldErrors.url}
            required
          >
            <Input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/hooks/storm"
            />
          </Field>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Events</Label>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() =>
                  setSelected((current) =>
                    current.size === events.length ? new Set() : new Set(events),
                  )
                }
              >
                {selected.size === events.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
              {events.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={selected.has(event)}
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(event);
                        else next.delete(event);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-xs">{event}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || !url.trim() || selected.size === 0}
            loading={create.isPending}
          >
            Create webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({
  issued,
  onClose,
}: {
  issued: { name: string; secret: string };
  onClose: () => void;
}) {
  const toast = useToast();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Signing secret for {issued.name}</DialogTitle>
          <DialogDescription>
            Shown once. The panel keeps it encrypted and cannot show it again — create a new webhook
            if you lose it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-2 rounded-lg border border-border bg-secondary/40 p-3">
            <code className="break-all font-mono text-sm">{issued.secret}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Copy the signing secret"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(issued.secret)
                  .then(() => toast.success('Copied'))
                  .catch(() =>
                    toast.error('Could not copy', 'Select the secret and copy it by hand.'),
                  );
              }}
            >
              <Copy />
            </Button>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Each delivery carries <code className="font-mono text-xs">x-storm-signature</code> in
              the form <code className="font-mono text-xs">t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>.
              The HMAC is SHA-256 over{' '}
              <code className="font-mono text-xs">&lt;t&gt;.&lt;raw body&gt;</code>
              with this secret.
            </p>
            <p>
              Compare it in constant time, and reject a timestamp that is not recent — otherwise a
              captured delivery can be replayed at you later.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>I have saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
