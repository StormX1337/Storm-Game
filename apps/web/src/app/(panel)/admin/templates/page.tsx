'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, Gamepad2, MoreVertical, Package, Search, Trash2 } from 'lucide-react';
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
import type { TemplateSummary } from '@storm/types';
import { api, apiPaginated, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';

export default function AdminTemplatesPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState('');
  const [cloning, setCloning] = React.useState<TemplateSummary | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'templates', search],
    queryFn: () =>
      apiPaginated<TemplateSummary>('/admin/templates', {
        query: { perPage: 100, search: search || undefined },
      }),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'templates'] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/templates/${id}`),
    onSuccess: () => {
      toast.success('Template deleted');
      invalidate();
    },
    onError: (error) => toast.error('Could not delete template', errorMessage(error)),
  });

  const exportTemplate = async (template: TemplateSummary): Promise<void> => {
    try {
      const data = await api.get<Record<string, unknown>>(`/admin/templates/${template.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${template.slug}.storm-template.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Template exported');
    } catch (error) {
      toast.error('Export failed', errorMessage(error));
    }
  };

  const grouped = React.useMemo(() => {
    const map = new Map<string, TemplateSummary[]>();
    for (const template of data?.items ?? []) {
      const list = map.get(template.category) ?? [];
      list.push(template);
      map.set(template.category, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Game templates</h1>
        <p className="text-sm text-muted-foreground">
          Install scripts, images and variables that define what a server runs.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search templates…"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((key) => (
            <Skeleton key={key} className="h-32" />
          ))}
        </div>
      ) : grouped.length > 0 ? (
        <div className="space-y-6">
          {grouped.map(([category, templates]) => (
            <div key={category} className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => (
                  <Card key={template.id} className="flex flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-medium">
                          <Gamepad2 className="h-4 w-4 shrink-0 text-primary" />
                          <span className="truncate">{template.name}</span>
                        </p>
                        <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
                          {template.slug} · v{template.version}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="Template actions">
                            <MoreVertical />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setCloning(template)}>
                            <Copy />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => void exportTemplate(template)}>
                            <Download />
                            Export JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            destructive
                            disabled={template.serverCount > 0}
                            onSelect={() => {
                              void confirm({
                                title: `Delete ${template.name}?`,
                                description:
                                  'The template is removed permanently. Servers using it must be deleted first.',
                                confirmLabel: 'Delete',
                                destructive: true,
                              }).then((confirmed) => {
                                if (confirmed) remove.mutate(template.id);
                              });
                            }}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <p className="mt-2 line-clamp-2 flex-1 text-xs text-muted-foreground">
                      {template.description}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
                      <Badge variant={template.isActive ? 'success' : 'muted'}>
                        {template.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                      <Badge variant="secondary">
                        {template.serverCount} server{template.serverCount === 1 ? '' : 's'}
                      </Badge>
                      {template.defaultPorts.length > 0 ? (
                        <Badge variant="muted">:{template.defaultPorts[0]}</Badge>
                      ) : null}
                    </div>

                    <p className="mt-2 text-2xs text-muted-foreground">
                      Added {formatDate(template.createdAt)} by {template.author}
                    </p>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={Package}
            title="No templates found"
            description="Templates define how a game server is installed and started."
          />
        </Card>
      )}

      {cloning ? (
        <CloneDialog
          template={cloning}
          onClose={() => setCloning(null)}
          onCloned={() => {
            setCloning(null);
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}

function CloneDialog({
  template,
  onClose,
  onCloned,
}: {
  template: TemplateSummary;
  onClose: () => void;
  onCloned: () => void;
}) {
  const toast = useToast();
  const [name, setName] = React.useState(`${template.name} (copy)`);
  const [slug, setSlug] = React.useState(`${template.slug}-copy`);

  const clone = useMutation({
    mutationFn: () => api.post(`/admin/templates/${template.id}/clone`, { name, slug }),
    onSuccess: () => {
      toast.success('Template duplicated');
      onCloned();
    },
    onError: (error) => toast.error('Could not duplicate', errorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate {template.name}</DialogTitle>
          <DialogDescription>
            The copy keeps every image, script and variable so you can edit it freely.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </Field>
          <Field label="Slug" hint="Lowercase letters, numbers and dashes." required>
            <Input
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              className="font-mono text-xs"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => clone.mutate()} disabled={!name || !slug} loading={clone.isPending}>
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
