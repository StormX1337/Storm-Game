'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Copy,
  Cpu,
  Download,
  HardDrive,
  MemoryStick,
  MoreVertical,
  Network,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { NodeDetail, NodeSummary } from '@storm/types';
import { ApiError, api, apiPaginated, errorMessage } from '@/lib/api';
import { formatBytes, formatMib, formatPercent, formatRelative } from '@/lib/format';
import { NodeStatusBadge } from '@/components/panel/stats';

export default function AdminNodesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [creating, setCreating] = React.useState(false);
  const [configFor, setConfigFor] = React.useState<NodeSummary | null>(null);
  const [allocationFor, setAllocationFor] = React.useState<NodeSummary | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => apiPaginated<NodeSummary>('/admin/nodes', { query: { perPage: 100 } }),
    refetchInterval: 30_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes'] });
  };

  const checkHealth = useMutation({
    mutationFn: (id: string) =>
      api.get<{ reachable: boolean; error?: string }>(`/admin/nodes/${id}/health`),
    onSuccess: (result) => {
      if (result.reachable) toast.success('Node is reachable', 'Details refreshed from the agent.');
      else toast.error('Node is not reachable', result.error ?? 'The agent did not respond.');
      invalidate();
    },
    onError: (error) => toast.error('Health check failed', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/nodes/${id}`),
    onSuccess: () => {
      toast.success('Node deleted');
      invalidate();
    },
    onError: (error) => toast.error('Could not delete node', errorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Nodes</h1>
          <p className="text-sm text-muted-foreground">
            Machines running the Storm Node Agent and hosting containers.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Add node
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-40" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="grid gap-4">
          {data.items.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              onHealthCheck={() => checkHealth.mutate(node.id)}
              onConfigure={() => setConfigFor(node)}
              onAllocations={() => setAllocationFor(node)}
              onDelete={() => {
                void confirm({
                  title: `Delete node ${node.name}?`,
                  description:
                    'The node is removed from the panel. Servers must be moved or deleted first.',
                  confirmLabel: 'Delete node',
                  confirmText: node.name,
                  destructive: true,
                }).then((confirmed) => {
                  if (confirmed) remove.mutate(node.id);
                });
              }}
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={Network}
            title="No nodes registered"
            description="Add a node, then run the installer on it to connect the agent."
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus />
                Add node
              </Button>
            }
          />
        </Card>
      )}

      {creating ? (
        <CreateNodeDialog
          onClose={() => setCreating(false)}
          onCreated={(node) => {
            setCreating(false);
            invalidate();
            setConfigFor(node);
          }}
        />
      ) : null}

      {configFor ? (
        <ConfigurationDialog node={configFor} onClose={() => setConfigFor(null)} />
      ) : null}

      {allocationFor ? (
        <AllocationsDialog
          node={allocationFor}
          onClose={() => setAllocationFor(null)}
          onChanged={invalidate}
        />
      ) : null}
    </div>
  );
}

function NodeCard({
  node,
  onHealthCheck,
  onConfigure,
  onAllocations,
  onDelete,
}: {
  node: NodeSummary;
  onHealthCheck: () => void;
  onConfigure: () => void;
  onAllocations: () => void;
  onDelete: () => void;
}) {
  const detail = useQuery({
    queryKey: ['admin', 'nodes', node.id],
    queryFn: () => api.get<NodeDetail>(`/admin/nodes/${node.id}`),
    refetchInterval: 20_000,
  });

  const live = detail.data?.liveStats ?? null;
  const memoryCeiling = node.memoryTotal * 1024 * 1024;
  const diskCeiling = node.diskTotal * 1024 * 1024;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{node.name}</h2>
            <NodeStatusBadge status={node.status} />
            {node.maintenanceMode ? <Badge variant="warning">Maintenance</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {node.location}
            {node.region ? ` · ${node.region}` : ''} · {node.hostname}
          </p>
          <p className="text-xs text-muted-foreground">
            {node.serverCount} server{node.serverCount === 1 ? '' : 's'} · {node.allocationCount}{' '}
            allocated ports · heartbeat {formatRelative(node.lastHeartbeatAt)}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onHealthCheck}>
            <RefreshCw />
            Check
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Node actions">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onConfigure}>
                <Download />
                Agent configuration
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onAllocations}>
                <Network />
                Manage ports
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onDelete}>
                <Trash2 />
                Delete node
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          icon={Cpu}
          label="CPU"
          value={live ? formatPercent(live.cpuPercent) : '—'}
          detail={`${node.cpuCores} cores`}
        />
        <Metric
          icon={MemoryStick}
          label="Memory"
          value={live ? formatBytes(live.memoryUsed, 0) : '—'}
          detail={`${formatMib(node.allocatedMemory, 0)} allocated of ${formatBytes(memoryCeiling, 0)}`}
        />
        <Metric
          icon={HardDrive}
          label="Disk"
          value={live ? formatBytes(live.diskUsed, 0) : '—'}
          detail={`${formatMib(node.allocatedDisk, 0)} allocated of ${formatBytes(diskCeiling, 0)}`}
        />
        <Metric
          icon={Activity}
          label="Containers"
          value={live ? `${live.containersRunning}/${live.containers}` : '—'}
          detail={
            node.dockerVersion ? `Docker ${node.dockerVersion}` : 'Agent has not reported yet'
          }
        />
      </div>
    </Card>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      <p className="truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function CreateNodeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (node: NodeSummary) => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    name: '',
    location: '',
    hostname: '',
    ip: '',
    scheme: 'https',
    agentPort: 8081,
    sftpPort: 2022,
    cpuCores: 4,
    memoryTotal: 16384,
    diskTotal: 204800,
  });
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const create = useMutation({
    mutationFn: () => api.post<{ node: NodeDetail }>('/admin/nodes', form),
    onSuccess: (result) => {
      toast.success('Node registered', 'Copy its configuration onto the machine next.');
      onCreated(result.node);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not create node', errorMessage(error));
    },
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({
      ...current,
      [key]:
        typeof current[key] === 'number' ? Number(event.target.value) || 0 : event.target.value,
    }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a node</DialogTitle>
          <DialogDescription>
            Register the machine here, then run the installer on it with the configuration this
            generates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" error={fieldErrors.name} required>
              <Input value={form.name} onChange={set('name')} placeholder="fsn-node-01" autoFocus />
            </Field>
            <Field label="Location" error={fieldErrors.location} required>
              <Input value={form.location} onChange={set('location')} placeholder="Falkenstein" />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Hostname"
              hint="FQDN the panel connects to"
              error={fieldErrors.hostname}
              required
            >
              <Input
                value={form.hostname}
                onChange={set('hostname')}
                placeholder="node1.example.com"
              />
            </Field>
            <Field label="IP address" error={fieldErrors.ip} required>
              <Input value={form.ip} onChange={set('ip')} placeholder="203.0.113.10" />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Scheme">
              <select
                value={form.scheme}
                onChange={(event) => setForm((c) => ({ ...c, scheme: event.target.value }))}
                className="flex h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="https">https</option>
                <option value="http">http</option>
              </select>
            </Field>
            <Field label="Agent port">
              <Input type="number" value={form.agentPort} onChange={set('agentPort')} />
            </Field>
            <Field label="SFTP port">
              <Input type="number" value={form.sftpPort} onChange={set('sftpPort')} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="CPU cores">
              <Input type="number" value={form.cpuCores} onChange={set('cpuCores')} />
            </Field>
            <Field label="Memory (MiB)">
              <Input type="number" value={form.memoryTotal} onChange={set('memoryTotal')} />
            </Field>
            <Field label="Disk (MiB)">
              <Input type="number" value={form.diskTotal} onChange={set('diskTotal')} />
            </Field>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!form.name || !form.location || !form.hostname || !form.ip}
            loading={create.isPending}
          >
            Register node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfigurationDialog({ node, onClose }: { node: NodeSummary; onClose: () => void }) {
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'nodes', node.id, 'configuration'],
    queryFn: () =>
      api.get<{ configuration: string; filename: string }>(`/admin/nodes/${node.id}/configuration`),
    // Each fetch mints a fresh token, so never serve it from cache.
    staleTime: 0,
    gcTime: 0,
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Agent configuration for {node.name}</DialogTitle>
          <DialogDescription>
            Save this as <code className="font-mono text-xs">/etc/storm/agent.env</code> on the
            node, then run the installer — it reads the file and asks nothing. A new token is issued
            each time this is opened, and any earlier one the node never used is revoked with it, so
            only the newest configuration works. The token a running node is already using keeps
            working.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <Skeleton className="h-64" />
        ) : (
          <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-secondary/40 p-3 font-mono text-xs">
            {data?.configuration}
          </pre>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (!data) return;
              void navigator.clipboard
                .writeText(data.configuration)
                .then(() => toast.success('Configuration copied'))
                .catch(() => toast.error('Could not copy'));
            }}
          >
            <Copy />
            Copy
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              if (!data) return;
              const blob = new Blob([data.configuration], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = data.filename;
              anchor.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download />
            Download
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AllocationRow {
  id: string;
  ip: string;
  port: number;
  protocol: string;
  isPrimary: boolean;
  server: { id: string; name: string; shortId: string } | null;
}

function AllocationsDialog({
  node,
  onClose,
  onChanged,
}: {
  node: NodeSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [ip, setIp] = React.useState(node.ip);
  const [rangeStart, setRangeStart] = React.useState(25565);
  const [rangeEnd, setRangeEnd] = React.useState(25595);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'nodes', node.id, 'allocations'],
    queryFn: () =>
      apiPaginated<AllocationRow>(`/admin/nodes/${node.id}/allocations`, {
        query: { perPage: 100 },
      }),
  });

  const add = useMutation({
    mutationFn: () =>
      api.post<{ created: number; skipped: number }>(`/admin/nodes/${node.id}/allocations`, {
        ip,
        portRangeStart: rangeStart,
        portRangeEnd: rangeEnd,
        protocol: 'TCP',
      }),
    onSuccess: (result) => {
      toast.success(
        `${result.created} port${result.created === 1 ? '' : 's'} added`,
        result.skipped > 0 ? `${result.skipped} already existed.` : undefined,
      );
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', node.id, 'allocations'] });
      onChanged();
    },
    onError: (error) => toast.error('Could not add ports', errorMessage(error)),
  });

  const prune = useMutation({
    mutationFn: () =>
      api.post<{ deleted: number }>(`/admin/nodes/${node.id}/allocations/prune`, {}),
    onSuccess: (result) => {
      toast.success(`${result.deleted} unassigned port(s) removed`);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'nodes', node.id, 'allocations'] });
      onChanged();
    },
    onError: (error) => toast.error('Could not prune ports', errorMessage(error)),
  });

  const assigned = data?.items.filter((row) => row.server).length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ports on {node.name}</DialogTitle>
          <DialogDescription>
            {data ? `${data.meta.total} ports · ${assigned} assigned` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <Field label="IP address">
              <Input value={ip} onChange={(event) => setIp(event.target.value)} />
            </Field>
            <Field label="From">
              <Input
                type="number"
                value={rangeStart}
                onChange={(event) => setRangeStart(Number(event.target.value) || 0)}
                className="w-24"
              />
            </Field>
            <Field label="To">
              <Input
                type="number"
                value={rangeEnd}
                onChange={(event) => setRangeEnd(Number(event.target.value) || 0)}
                className="w-24"
              />
            </Field>
            <Button onClick={() => add.mutate()} loading={add.isPending}>
              <Plus />
              Add
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
            {isLoading ? (
              <div className="space-y-1 p-3">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : data && data.items.length > 0 ? (
              <div className="divide-y divide-border">
                {data.items.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="font-mono text-sm">
                      {row.ip}:{row.port}
                    </span>
                    {row.server ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Server className="h-3 w-3" />
                        {row.server.name}
                      </span>
                    ) : (
                      <Badge variant="muted">free</Badge>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                No ports allocated yet.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => prune.mutate()} loading={prune.isPending}>
            <Trash2 />
            Remove unassigned
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
