'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, ExternalLink, Package, Search } from 'lucide-react';
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
import { MODPACK_LOADER } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

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

interface ModpackVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  releaseType: string;
  filename: string;
  bytes: number;
}

interface InstallResult {
  name: string;
  version: string;
  minecraft: string;
  installed: number;
  skippedClientOnly: string[];
  keptExisting: string[];
  message: string;
}

/**
 * Browsing and installing Minecraft modpacks.
 *
 * The page says up front what the server is set to run, because a modpack is
 * the one thing here that a correctly working panel will refuse. Finding that
 * out after picking a pack, reading a paragraph and pressing Install is a
 * worse experience than being told before the search box.
 */
export default function ServerModpacksPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();

  const [term, setTerm] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<InstallResult | null>(null);

  const mayWrite = can('servers.files.write');

  const search = useQuery({
    queryKey: ['server', server.id, 'modpack-search', submitted],
    queryFn: () =>
      api.get<SearchHit[]>(`/servers/${server.id}/modpacks/search`, {
        query: { q: submitted },
      }),
    staleTime: 5 * 60_000,
  });

  const versions = useQuery({
    queryKey: ['server', server.id, 'modpack-versions', expanded],
    queryFn: () => api.get<ModpackVersion[]>(`/servers/${server.id}/modpacks/${expanded}/versions`),
    enabled: expanded !== null,
  });

  const install = useMutation({
    mutationFn: (versionId: string) =>
      api.post<InstallResult>(`/servers/${server.id}/modpacks`, { versionId }),
    onSuccess: (data) => {
      setResult(data);
      toast.success(`Installed ${data.name}`, data.message);
    },
    onError: (error) => toast.error('Could not install that modpack', errorMessage(error)),
  });

  // Read off the server the page already has, rather than asked for.
  // Whether this customer's own server can run a pack has nothing to do with
  // whether Modrinth is reachable, and a card that sat on a spinner until a
  // third party answered told them nothing when it mattered most.
  const startup = (key: string): string =>
    server.variables.find((entry) => entry.key === key)?.value ?? '';

  const project = startup('PROJECT');
  const minecraftVersion = startup('MINECRAFT_VERSION');
  const loaderReady = project === MODPACK_LOADER;
  const versionPinned = minecraftVersion !== 'latest' && minecraftVersion !== '';
  const running = server.status !== 'OFFLINE';

  const askInstall = async (versionId: string, title: string): Promise<void> => {
    const confirmed = await confirm({
      title: `Install ${title}?`,
      description:
        'The pack writes its mods and its configuration into the server, replacing files of the same name. Your world is left alone, but a backup first is the cheap version of finding out.',
      confirmLabel: 'Install',
    });
    if (confirmed) install.mutate(versionId);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>This server</CardTitle>
          <CardDescription>
            A pack is only installed into a server that can run it. These are the two settings that
            decide, and both are on the Startup tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Project</span>
              <Badge variant={loaderReady ? 'success' : 'warning'}>{project || 'not set'}</Badge>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Minecraft</span>
              <Badge variant={versionPinned ? 'success' : 'warning'}>
                {minecraftVersion || 'not set'}
              </Badge>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={running ? 'warning' : 'success'}>
                {running ? server.status : 'Offline'}
              </Badge>
            </span>
          </div>

          {!loaderReady ? (
            <Notice>
              Packs need <strong>{MODPACK_LOADER}</strong>, and this server is set to{' '}
              <strong>{project || 'nothing'}</strong>. Change Project on the Startup tab and
              reinstall the server before installing a pack. Reinstalling erases the server&apos;s
              files, so take a backup first if it has a world worth keeping.
            </Notice>
          ) : null}
          {loaderReady && !versionPinned ? (
            <Notice>
              Minecraft Version is <strong>{minecraftVersion || 'not set'}</strong>, which is an
              instruction rather than a version — the panel cannot tell what is actually installed.
              Pin it on the Startup tab to the version the pack is built for.
            </Notice>
          ) : null}
          {loaderReady && versionPinned && running ? (
            <Notice>Stop the server before installing a pack.</Notice>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {result.name} {result.version}
            </CardTitle>
            <CardDescription>{result.message}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              {result.installed} file{result.installed === 1 ? '' : 's'} written for Minecraft{' '}
              {result.minecraft}.
            </p>
            {result.skippedClientOnly.length > 0 ? (
              <p className="text-muted-foreground">
                {result.skippedClientOnly.length} client-only file
                {result.skippedClientOnly.length === 1 ? ' was' : 's were'} left out. They crash a
                server rather than doing nothing on it.
              </p>
            ) : null}
            {result.keptExisting.length > 0 ? (
              <p className="text-muted-foreground">
                Kept your existing {result.keptExisting.join(', ')} rather than overwriting{' '}
                {result.keptExisting.length === 1 ? 'it' : 'them'} with the pack&apos;s.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Find a modpack</CardTitle>
          <CardDescription>
            Searches Modrinth for Fabric packs. The panel opens the pack itself, checks every
            download inside it against the addresses it is allowed to fetch, and only then tells the
            node what to get.
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
              placeholder="Fabulously Optimized, Adrenaline, Simply Optimized…"
              aria-label="Search modpacks"
            />
            <Button type="submit" loading={search.isFetching}>
              <Search />
              Search
            </Button>
          </form>

          {search.isError ? (
            <p className="text-sm text-destructive">{errorMessage(search.error)}</p>
          ) : search.isLoading ? (
            <Skeleton className="h-40" />
          ) : (search.data?.length ?? 0) === 0 ? (
            <EmptyState icon={Package} title="Nothing matched that search" />
          ) : (
            <ul className="space-y-3">
              {search.data?.map((hit) => (
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
                      // Disabled rather than hidden: the reason is on screen
                      // above, and a button that vanishes explains nothing.
                      blocked={!loaderReady || !versionPinned || running}
                      onInstall={(versionId) => void askInstall(versionId, hit.title)}
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-warning">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

function VersionPicker({
  versions,
  loading,
  installing,
  blocked,
  onInstall,
}: {
  versions: ModpackVersion[];
  loading: boolean;
  installing: boolean;
  blocked: boolean;
  onInstall: (versionId: string) => void;
}) {
  const [chosen, setChosen] = React.useState('');

  React.useEffect(() => {
    setChosen(versions[0]?.versionId ?? '');
  }, [versions]);

  if (loading) return <Skeleton className="mt-3 h-10" />;
  if (versions.length === 0) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        No Fabric build of this pack is published.
      </p>
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

      <Button
        size="sm"
        disabled={!chosen || blocked}
        loading={installing}
        onClick={() => onInstall(chosen)}
      >
        <Download />
        Install
      </Button>
    </div>
  );
}
