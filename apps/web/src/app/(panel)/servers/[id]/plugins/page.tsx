'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Blocks, Download, ExternalLink, Search, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

interface InstalledPlugin {
  filename: string;
  bytes: number;
  modifiedAt: string;
}

interface SearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
  pageUrl: string;
}

interface PluginVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  releaseType: string;
  filename: string;
  bytes: number;
}

/**
 * Browsing and installing Minecraft plugins.
 *
 * The tab only exists on a server whose template says it uses plugins, and the
 * API answers 404 anywhere else — so this page never has to ask whether it
 * belongs here.
 */
export default function ServerPluginsPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [term, setTerm] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const mayWrite = can('servers.files.write');

  const installed = useQuery({
    queryKey: ['server', server.id, 'plugins'],
    queryFn: () => api.get<InstalledPlugin[]>(`/servers/${server.id}/plugins`),
  });

  const results = useQuery({
    queryKey: ['server', server.id, 'plugin-search', submitted],
    queryFn: () =>
      api.get<SearchHit[]>(`/servers/${server.id}/plugins/search`, {
        query: { q: submitted },
      }),
    // The registry is a third party; asking it again on every focus would be
    // rude to it and slow for the customer.
    staleTime: 5 * 60_000,
  });

  const versions = useQuery({
    queryKey: ['server', server.id, 'plugin-versions', expanded],
    queryFn: () => api.get<PluginVersion[]>(`/servers/${server.id}/plugins/${expanded}/versions`),
    enabled: expanded !== null,
  });

  const install = useMutation({
    mutationFn: (versionId: string) =>
      api.post<{ filename: string; message: string }>(`/servers/${server.id}/plugins`, {
        versionId,
      }),
    onSuccess: (result) => {
      toast.success(`Installed ${result.filename}`, result.message);
      void queryClient.invalidateQueries({ queryKey: ['server', server.id, 'plugins'] });
    },
    onError: (error) => toast.error('Could not install that plugin', errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (filename: string) =>
      api.delete<{ message: string }>(
        `/servers/${server.id}/plugins/${encodeURIComponent(filename)}`,
      ),
    onSuccess: (result) => {
      toast.success('Plugin removed', result.message);
      void queryClient.invalidateQueries({ queryKey: ['server', server.id, 'plugins'] });
    },
    onError: (error) => toast.error('Could not remove that plugin', errorMessage(error)),
  });

  const askRemove = async (filename: string): Promise<void> => {
    const confirmed = await confirm({
      title: `Remove ${filename}?`,
      description:
        'The jar is deleted from the plugins directory. Anything the plugin has already written — its config, its data — is left alone.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (confirmed) remove.mutate(filename);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Installed</CardTitle>
          <CardDescription>
            Jars in the server&apos;s <code className="font-mono">plugins</code> folder. Changes
            take effect on the next restart.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {installed.isLoading ? (
            <Skeleton className="h-20" />
          ) : (installed.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing installed yet. Search below to add one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {installed.data?.map((plugin) => (
                <li
                  key={plugin.filename}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{plugin.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(plugin.bytes)} · added {formatRelative(plugin.modifiedAt)}
                    </p>
                  </div>
                  {mayWrite ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => void askRemove(plugin.filename)}
                    >
                      <Trash2 />
                      Remove
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Find a plugin</CardTitle>
          <CardDescription>
            Searches Modrinth. The panel downloads the file to the node itself and checks it against
            the checksum Modrinth publishes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(term.trim());
              setExpanded(null);
            }}
          >
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="EssentialsX, WorldEdit, LuckPerms…"
              aria-label="Search plugins"
            />
            <Button type="submit" loading={results.isFetching}>
              <Search />
              Search
            </Button>
          </form>

          {results.isError ? (
            <p className="text-sm text-destructive">{errorMessage(results.error)}</p>
          ) : results.isLoading ? (
            <Skeleton className="h-40" />
          ) : (results.data?.length ?? 0) === 0 ? (
            <EmptyState icon={Blocks} title="Nothing matched that search" />
          ) : (
            <ul className="space-y-3">
              {results.data?.map((hit) => (
                <li key={hit.projectId} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{hit.title}</p>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {hit.description}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {hit.downloads.toLocaleString('en-GB')} downloads
                        {hit.categories.length > 0 ? ` · ${hit.categories.join(', ')}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <a
                        href={hit.pageUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Open ${hit.title} on Modrinth`}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                      {mayWrite ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setExpanded(expanded === hit.projectId ? null : hit.projectId)
                          }
                        >
                          {expanded === hit.projectId ? 'Hide versions' : 'Choose a version'}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {expanded === hit.projectId ? (
                    <VersionPicker
                      versions={versions.data ?? []}
                      loading={versions.isLoading}
                      installing={install.isPending}
                      onInstall={(versionId) => install.mutate(versionId)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function VersionPicker({
  versions,
  loading,
  installing,
  onInstall,
}: {
  versions: PluginVersion[];
  loading: boolean;
  installing: boolean;
  onInstall: (versionId: string) => void;
}) {
  const [chosen, setChosen] = React.useState('');

  React.useEffect(() => {
    // Newest build by default: it is what almost everyone wants, and the list
    // arrives in that order.
    setChosen(versions[0]?.versionId ?? '');
  }, [versions]);

  if (loading) return <Skeleton className="mt-3 h-10" />;
  if (versions.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">No downloadable build for this plugin.</p>
    );
  }

  const selected = versions.find((version) => version.versionId === chosen);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <Select value={chosen} onValueChange={setChosen}>
        <SelectTrigger className="max-w-[280px]" aria-label="Version">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {versions.slice(0, 40).map((version) => (
            <SelectItem key={version.versionId} value={version.versionId}>
              {version.versionNumber} · {version.gameVersions.slice(0, 3).join(', ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {selected ? (
        <Badge variant={selected.releaseType === 'release' ? 'success' : 'warning'}>
          {selected.releaseType}
        </Badge>
      ) : null}
      {selected ? (
        <span className="text-xs text-muted-foreground">{formatBytes(selected.bytes)}</span>
      ) : null}

      <Button size="sm" disabled={!chosen} loading={installing} onClick={() => onInstall(chosen)}>
        <Download />
        Install
      </Button>
    </div>
  );
}
