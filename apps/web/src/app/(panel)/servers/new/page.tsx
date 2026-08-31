'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cpu,
  Gamepad2,
  HardDrive,
  Loader2,
  MapPin,
  MemoryStick,
  Rocket,
  Server,
  Settings2,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Skeleton,
  cn,
  useToast,
} from '@storm/ui';
import type { NodeSummary, ServerSummary, TemplateDetail, TemplateSummary } from '@storm/types';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatMib } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';

interface NodeWithCapacity extends NodeSummary {
  freeAllocations: number;
  availableMemory: number;
  availableDisk: number;
}

const STEPS = [
  { key: 'game', label: 'Game', icon: Gamepad2 },
  { key: 'node', label: 'Location', icon: MapPin },
  { key: 'resources', label: 'Resources', icon: Settings2 },
  { key: 'review', label: 'Review', icon: Rocket },
] as const;

export default function CreateServerPage() {
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();

  const [step, setStep] = React.useState(0);
  const [templateId, setTemplateId] = React.useState<string | null>(null);
  const [nodeId, setNodeId] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [category, setCategory] = React.useState('all');
  const [limits, setLimits] = React.useState({
    cpuLimit: 200,
    memoryLimit: 2048,
    diskLimit: 10240,
    swapLimit: 0,
    ioWeight: 500,
    pidsLimit: 512,
    oomKill: true,
  });
  const [variables, setVariables] = React.useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<TemplateSummary[]>('/templates'),
  });

  const template = useQuery({
    queryKey: ['templates', templateId],
    queryFn: () => api.get<TemplateDetail>(`/templates/${templateId}`),
    enabled: templateId !== null,
  });

  const nodes = useQuery({
    queryKey: ['nodes', 'available'],
    queryFn: () => api.get<NodeWithCapacity[]>('/nodes'),
  });

  // Seed the variable form from the template's defaults the first time it loads.
  React.useEffect(() => {
    if (!template.data) return;
    setVariables(
      Object.fromEntries(
        template.data.variables.map((variable) => [variable.envVariable, variable.defaultValue]),
      ),
    );
    if (!name) setName(`${template.data.name} server`);
  }, [template.data, name]);

  const create = useMutation({
    mutationFn: () =>
      api.post<ServerSummary>('/servers', {
        name: name.trim(),
        nodeId,
        templateId,
        environment: variables,
        limits,
        startOnCompletion: true,
      }),
    onSuccess: (server) => {
      toast.success('Server created', 'Installation has started — this can take a few minutes.');
      router.push(`/servers/${server.shortId}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not create the server', errorMessage(error));
    },
  });

  const categories = React.useMemo(() => {
    const set = new Set((templates.data ?? []).map((entry) => entry.category));
    return ['all', ...[...set].sort()];
  }, [templates.data]);

  const visibleTemplates = (templates.data ?? []).filter(
    (entry) => category === 'all' || entry.category === category,
  );

  const selectedNode = nodes.data?.find((entry) => entry.id === nodeId) ?? null;
  const selectedTemplate = templates.data?.find((entry) => entry.id === templateId) ?? null;

  const canAdvance =
    (step === 0 && templateId !== null) ||
    (step === 1 && nodeId !== null) ||
    (step === 2 && name.trim().length > 0) ||
    step === 3;

  const capacityWarning =
    selectedNode && limits.memoryLimit > selectedNode.availableMemory
      ? `That node has ${formatMib(selectedNode.availableMemory, 0)} of memory left.`
      : selectedNode && limits.diskLimit > selectedNode.availableDisk
        ? `That node has ${formatMib(selectedNode.availableDisk, 0)} of disk left.`
        : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" onClick={() => router.push('/servers')} className="-ml-2">
          <ArrowLeft />
          Back to servers
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Create a server</h1>
        <p className="text-sm text-muted-foreground">
          Pick a game, choose where it runs and set its resources.
        </p>
      </div>

      <ol className="flex items-center gap-1">
        {STEPS.map((entry, index) => {
          const state = index === step ? 'current' : index < step ? 'done' : 'todo';
          return (
            <li key={entry.key} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => index < step && setStep(index)}
                disabled={index > step}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                  state === 'current' && 'bg-primary/10 font-medium text-primary',
                  state === 'done' && 'text-foreground hover:bg-secondary',
                  state === 'todo' && 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full text-2xs font-semibold',
                    state === 'current' && 'bg-primary text-primary-foreground',
                    state === 'done' && 'bg-success text-success-foreground',
                    state === 'todo' && 'border border-border',
                  )}
                >
                  {state === 'done' ? <Check className="h-3 w-3" /> : index + 1}
                </span>
                <span className="hidden sm:inline">{entry.label}</span>
              </button>
              {index < STEPS.length - 1 ? (
                <span className={cn('h-px flex-1', index < step ? 'bg-success' : 'bg-border')} />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* ------------------------------------------------------ step 1 -- */}
      {step === 0 ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {categories.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setCategory(entry)}
                className={cn(
                  'rounded-lg border px-3 py-1 text-sm transition-colors',
                  category === entry
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-secondary',
                )}
              >
                {entry === 'all' ? 'All games' : entry}
              </button>
            ))}
          </div>

          {templates.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2, 3, 4, 5].map((key) => (
                <Skeleton key={key} className="h-28" />
              ))}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleTemplates.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTemplateId(entry.id)}
                  className={cn(
                    'rounded-xl border p-4 text-left transition-all',
                    templateId === entry.id
                      ? 'border-primary bg-primary/[0.06] ring-1 ring-primary'
                      : 'border-border hover:border-primary/40 hover:bg-secondary/40',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Gamepad2
                      className={cn(
                        'h-5 w-5 shrink-0',
                        templateId === entry.id ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    {templateId === entry.id ? (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    ) : null}
                  </div>
                  <p className="mt-2.5 font-medium leading-tight">{entry.name}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {entry.description}
                  </p>
                  <Badge variant="secondary" className="mt-2.5 text-2xs">
                    {entry.category}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------------------ step 2 -- */}
      {step === 1 ? (
        <div className="space-y-3">
          {nodes.isLoading ? (
            <>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </>
          ) : nodes.data && nodes.data.length > 0 ? (
            nodes.data.map((node) => {
              const usable = node.freeAllocations > 0 && node.status === 'ONLINE';
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => usable && setNodeId(node.id)}
                  disabled={!usable}
                  className={cn(
                    'w-full rounded-xl border p-4 text-left transition-all',
                    nodeId === node.id
                      ? 'border-primary bg-primary/[0.06] ring-1 ring-primary'
                      : 'border-border hover:border-primary/40 hover:bg-secondary/40',
                    !usable &&
                      'cursor-not-allowed opacity-50 hover:border-border hover:bg-transparent',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 font-medium">
                        <Server className="h-4 w-4 text-muted-foreground" />
                        {node.name}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        {node.location}
                        {node.region ? ` · ${node.region}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm">
                      <Metric label="Free memory" value={formatMib(node.availableMemory, 0)} />
                      <Metric label="Free disk" value={formatMib(node.availableDisk, 0)} />
                      <Metric label="Free ports" value={String(node.freeAllocations)} />
                    </div>
                  </div>
                  {!usable ? (
                    <p className="mt-2 text-xs text-warning">
                      {node.status !== 'ONLINE'
                        ? 'This node is not accepting servers right now.'
                        : 'No free ports available on this node.'}
                    </p>
                  ) : null}
                </button>
              );
            })
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No nodes are available for deployment. Contact an administrator.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

      {/* ------------------------------------------------------ step 3 -- */}
      {step === 2 ? (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Server name</CardTitle>
            </CardHeader>
            <CardContent>
              <Field label="Name" error={fieldErrors.name} required>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My survival server"
                  autoFocus
                />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Resources</CardTitle>
              <CardDescription>
                These become hard limits on the container. You can change them later.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <Field label="CPU" hint="100% equals one core">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Input
                    type="number"
                    min={25}
                    max={6400}
                    step={25}
                    value={limits.cpuLimit}
                    onChange={(event) =>
                      setLimits((current) => ({
                        ...current,
                        cpuLimit: Number(event.target.value) || 0,
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </Field>

              <Field label="Memory" hint="Megabytes">
                <div className="flex items-center gap-2">
                  <MemoryStick className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Input
                    type="number"
                    min={128}
                    step={256}
                    value={limits.memoryLimit}
                    onChange={(event) =>
                      setLimits((current) => ({
                        ...current,
                        memoryLimit: Number(event.target.value) || 0,
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">MiB</span>
                </div>
              </Field>

              <Field label="Disk" hint="Megabytes">
                <div className="flex items-center gap-2">
                  <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Input
                    type="number"
                    min={512}
                    step={1024}
                    value={limits.diskLimit}
                    onChange={(event) =>
                      setLimits((current) => ({
                        ...current,
                        diskLimit: Number(event.target.value) || 0,
                      }))
                    }
                  />
                  <span className="text-sm text-muted-foreground">MiB</span>
                </div>
              </Field>
            </CardContent>
            {capacityWarning ? (
              <CardContent className="pt-0">
                <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                  {capacityWarning}
                </p>
              </CardContent>
            ) : null}
          </Card>

          {template.data && template.data.variables.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>{template.data.name} settings</CardTitle>
                <CardDescription>Defaults work for most servers.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                {template.data.variables
                  .filter((variable) => variable.userEditable)
                  .map((variable) => (
                    <Field
                      key={variable.envVariable}
                      label={variable.name}
                      hint={variable.description}
                      error={fieldErrors[variable.envVariable]}
                    >
                      <Input
                        value={variables[variable.envVariable] ?? ''}
                        onChange={(event) =>
                          setVariables((current) => ({
                            ...current,
                            [variable.envVariable]: event.target.value,
                          }))
                        }
                        className="font-mono text-xs"
                      />
                    </Field>
                  ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------------------------------ step 4 -- */}
      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle>Review</CardTitle>
            <CardDescription>
              The server is created and installed immediately, then started automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ReviewRow label="Name" value={name} />
            <ReviewRow label="Game" value={selectedTemplate?.name ?? '—'} />
            <ReviewRow
              label="Location"
              value={selectedNode ? `${selectedNode.name} · ${selectedNode.location}` : '—'}
            />
            <ReviewRow label="CPU" value={`${(limits.cpuLimit / 100).toFixed(2)} cores`} />
            <ReviewRow label="Memory" value={formatMib(limits.memoryLimit, 0)} />
            <ReviewRow label="Disk" value={formatMib(limits.diskLimit, 0)} />
            {user && user.limits.serverLimit > 0 ? (
              <p className="border-t border-border pt-3 text-xs text-muted-foreground">
                You may own up to {user.limits.serverLimit} servers on this account.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="outline"
          onClick={() => setStep((current) => Math.max(0, current - 1))}
          disabled={step === 0 || create.isPending}
        >
          <ArrowLeft />
          Back
        </Button>

        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((current) => current + 1)} disabled={!canAdvance}>
            Continue
            <ArrowRight />
          </Button>
        ) : (
          <Button onClick={() => create.mutate()} loading={create.isPending} size="lg">
            {create.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
            Create server
          </Button>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
