'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Copy,
  Download,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileText,
  FolderPlus,
  Folder,
  FilePlus,
  Home,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Button,
  Card,
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { AgentFileEntry } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatBytes, formatRelative } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';
import { FileEditor } from '@/components/panel/file-editor';

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'md', 'json', 'yml', 'yaml', 'xml', 'properties', 'cfg', 'conf',
  'ini', 'toml', 'sh', 'bat', 'js', 'ts', 'lua', 'py', 'sql', 'env', 'csv', 'html', 'css',
]);

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

function iconFor(entry: AgentFileEntry): React.ComponentType<{ className?: string }> {
  if (entry.isDirectory) return Folder;
  const extension = extensionOf(entry.name);
  if (['zip', 'gz', 'tar', 'rar', '7z', 'jar'].includes(extension)) return FileArchive;
  if (['js', 'ts', 'json', 'lua', 'py', 'sh', 'yml', 'yaml', 'xml'].includes(extension)) return FileCode;
  if (TEXT_EXTENSIONS.has(extension)) return FileText;
  return FileIcon;
}

export default function FilesPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [path, setPath] = React.useState('/');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [editing, setEditing] = React.useState<{ path: string; content: string } | null>(null);
  const [creating, setCreating] = React.useState<'file' | 'folder' | null>(null);
  const [newName, setNewName] = React.useState('');
  const [renaming, setRenaming] = React.useState<AgentFileEntry | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const writable = can('servers.files.write') && !server.suspended;

  const listing = useQuery({
    queryKey: ['server', server.shortId, 'files', path],
    queryFn: () =>
      api.get<{ path: string; entries: AgentFileEntry[] }>(`/servers/${server.id}/files/list`, {
        query: { path },
      }),
  });

  const searchResults = useQuery({
    queryKey: ['server', server.shortId, 'files', 'search', search],
    queryFn: () =>
      api.get<AgentFileEntry[]>(`/servers/${server.id}/files/search`, {
        query: { path: '/', query: search },
      }),
    enabled: search.trim().length > 1,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'files'] });
    setSelected(new Set());
  };

  /* ---------------------------------------------------------- mutations -- */

  const deleteMutation = useMutation({
    mutationFn: (paths: string[]) => api.post(`/servers/${server.id}/files/delete`, { paths }),
    onSuccess: (_data, paths) => {
      toast.success(`Deleted ${paths.length} item${paths.length === 1 ? '' : 's'}`);
      refresh();
    },
    onError: (error) => toast.error('Delete failed', errorMessage(error)),
  });

  const createMutation = useMutation({
    mutationFn: async (input: { kind: 'file' | 'folder'; name: string }) => {
      if (input.kind === 'folder') {
        return api.post(`/servers/${server.id}/files/create-directory`, { path, name: input.name });
      }
      const target = path === '/' ? `/${input.name}` : `${path}/${input.name}`;
      return api.post(`/servers/${server.id}/files/write`, { path: target, content: '' });
    },
    onSuccess: () => {
      toast.success(creating === 'folder' ? 'Folder created' : 'File created');
      setCreating(null);
      setNewName('');
      refresh();
    },
    onError: (error) => toast.error('Could not create', errorMessage(error)),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      api.post(`/servers/${server.id}/files/rename`, input),
    onSuccess: () => {
      toast.success('Renamed');
      setRenaming(null);
      refresh();
    },
    onError: (error) => toast.error('Rename failed', errorMessage(error)),
  });

  const copyMutation = useMutation({
    mutationFn: (target: string) => api.post(`/servers/${server.id}/files/copy`, { path: target }),
    onSuccess: () => {
      toast.success('Copied');
      refresh();
    },
    onError: (error) => toast.error('Copy failed', errorMessage(error)),
  });

  const compressMutation = useMutation({
    mutationFn: (files: string[]) =>
      api.post<{ archive: string }>(`/servers/${server.id}/files/compress`, { path, files }),
    onSuccess: (data) => {
      toast.success('Archive created', data.archive);
      refresh();
    },
    onError: (error) => toast.error('Could not create archive', errorMessage(error)),
  });

  const decompressMutation = useMutation({
    mutationFn: (file: string) => api.post(`/servers/${server.id}/files/decompress`, { path, file }),
    onSuccess: () => {
      toast.success('Archive extracted');
      refresh();
    },
    onError: (error) => toast.error('Extract failed', errorMessage(error)),
  });

  /* ------------------------------------------------------------ actions -- */

  const openEntry = async (entry: AgentFileEntry): Promise<void> => {
    if (entry.isDirectory) {
      setPath(entry.path);
      setSearch('');
      setSelected(new Set());
      return;
    }

    const extension = extensionOf(entry.name);
    if (!TEXT_EXTENSIONS.has(extension) && entry.size > 512 * 1024) {
      toast.info('Not a text file', 'Download it instead of opening it in the editor.');
      return;
    }

    try {
      const content = await api.get<string>(`/servers/${server.id}/files/contents`, {
        query: { path: entry.path },
      });
      setEditing({ path: entry.path, content: typeof content === 'string' ? content : '' });
    } catch (error) {
      toast.error('Could not open file', errorMessage(error));
    }
  };

  const download = (entry: AgentFileEntry): void => {
    const url = `/api/v1/servers/${server.id}/files/download?path=${encodeURIComponent(entry.path)}`;
    window.open(url, '_blank', 'noopener');
  };

  const removeEntries = async (paths: string[]): Promise<void> => {
    const confirmed = await confirm({
      title: paths.length === 1 ? 'Delete this item?' : `Delete ${paths.length} items?`,
      description: 'Deleted files cannot be recovered unless you have a backup.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (confirmed) deleteMutation.mutate(paths);
  };

  const upload = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;

    setUploading(true);
    setUploadProgress(0);

    try {
      // Uploaded one at a time so progress is meaningful and a single failure
      // does not discard the whole batch.
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const body = new FormData();
        body.append('file', file);

        await api.post(`/servers/${server.id}/files/upload`, body, { query: { path } });
        setUploadProgress(Math.round(((index + 1) / files.length) * 100));
      }
      toast.success(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
      refresh();
    } catch (error) {
      toast.error('Upload failed', errorMessage(error));
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const entries = search.trim().length > 1 ? (searchResults.data ?? []) : (listing.data?.entries ?? []);
  const segments = path.split('/').filter(Boolean);

  const allSelected = entries.length > 0 && selected.size === entries.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search files by name…"
            className="pl-9"
          />
        </div>

        <Button variant="outline" size="sm" onClick={refresh} disabled={listing.isFetching}>
          <RefreshCw className={cn(listing.isFetching && 'animate-spin')} />
          Refresh
        </Button>

        {writable ? (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => void upload(event.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              loading={uploading}
            >
              <Upload />
              {uploading ? `${uploadProgress}%` : 'Upload'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCreating('folder')}>
              <FolderPlus />
              Folder
            </Button>
            <Button size="sm" onClick={() => setCreating('file')}>
              <FilePlus />
              File
            </Button>
          </>
        ) : null}
      </div>

      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Breadcrumb">
        <button
          type="button"
          onClick={() => {
            setPath('/');
            setSearch('');
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Home className="h-3.5 w-3.5" />
          container
        </button>
        {segments.map((segment, index) => {
          const target = `/${segments.slice(0, index + 1).join('/')}`;
          const last = index === segments.length - 1;
          return (
            <React.Fragment key={target}>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => {
                  setPath(target);
                  setSearch('');
                }}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors hover:bg-secondary',
                  last ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {segment}
              </button>
            </React.Fragment>
          );
        })}
      </nav>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="ml-auto flex gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                compressMutation.mutate(
                  [...selected].map((entry) => entry.split('/').pop() ?? entry),
                )
              }
              loading={compressMutation.isPending}
            >
              <FileArchive />
              Archive
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => void removeEntries([...selected])}
              loading={deleteMutation.isPending}
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {listing.isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={Folder}
            title={search ? 'No files match' : 'This folder is empty'}
            description={
              search ? 'Try a different search term.' : 'Upload files or create one to get started.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  {writable ? (
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(checked) =>
                        setSelected(checked === true ? new Set(entries.map((e) => e.path)) : new Set())
                      }
                      aria-label="Select all"
                    />
                  ) : null}
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="w-28">Size</TableHead>
                <TableHead className="w-20">Mode</TableHead>
                <TableHead className="w-40">Modified</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const Icon = iconFor(entry);
                const isArchive = ['zip'].includes(extensionOf(entry.name));

                return (
                  <ContextMenu key={entry.path}>
                    <ContextMenuTrigger asChild>
                      <TableRow interactive>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          {writable ? (
                            <Checkbox
                              checked={selected.has(entry.path)}
                              onCheckedChange={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (checked === true) next.add(entry.path);
                                  else next.delete(entry.path);
                                  return next;
                                })
                              }
                              aria-label={`Select ${entry.name}`}
                            />
                          ) : null}
                        </TableCell>
                        <TableCell onClick={() => void openEntry(entry)}>
                          <span className="flex items-center gap-2">
                            <Icon
                              className={cn(
                                'h-4 w-4 shrink-0',
                                entry.isDirectory ? 'text-primary' : 'text-muted-foreground',
                              )}
                            />
                            <span className="truncate font-medium">{entry.name}</span>
                            {entry.isSymlink ? (
                              <span className="text-2xs text-muted-foreground">link</span>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {entry.isDirectory ? '—' : formatBytes(entry.size)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {entry.mode}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatRelative(entry.modifiedAt)}
                        </TableCell>
                        <TableCell onClick={(event) => event.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label="File actions">
                                <MoreVertical />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!entry.isDirectory ? (
                                <DropdownMenuItem onSelect={() => download(entry)}>
                                  <Download />
                                  Download
                                </DropdownMenuItem>
                              ) : null}
                              {writable ? (
                                <>
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      setRenaming(entry);
                                      setRenameValue(entry.name);
                                    }}
                                  >
                                    <Pencil />
                                    Rename
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onSelect={() => copyMutation.mutate(entry.path)}>
                                    <Copy />
                                    Duplicate
                                  </DropdownMenuItem>
                                  {isArchive ? (
                                    <DropdownMenuItem
                                      onSelect={() => decompressMutation.mutate(entry.name)}
                                    >
                                      <FileArchive />
                                      Extract here
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    destructive
                                    onSelect={() => void removeEntries([entry.path])}
                                  >
                                    <Trash2 />
                                    Delete
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    </ContextMenuTrigger>

                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => void openEntry(entry)}>
                        {entry.isDirectory ? 'Open folder' : 'Open in editor'}
                      </ContextMenuItem>
                      {!entry.isDirectory ? (
                        <ContextMenuItem onSelect={() => download(entry)}>Download</ContextMenuItem>
                      ) : null}
                      {writable ? (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            destructive
                            onSelect={() => void removeEntries([entry.path])}
                          >
                            Delete
                          </ContextMenuItem>
                        </>
                      ) : null}
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* ------------------------------------------------------- dialogs -- */}

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{creating === 'folder' ? 'New folder' : 'New file'}</DialogTitle>
            <DialogDescription>
              Created in <span className="font-mono">{path}</span>
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" required>
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={creating === 'folder' ? 'plugins' : 'config.yml'}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim()) {
                  createMutation.mutate({ kind: creating ?? 'file', name: newName.trim() });
                }
              }}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate({ kind: creating ?? 'file', name: newName.trim() })}
              disabled={!newName.trim()}
              loading={createMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <Field label="New name" required>
            <Input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!renaming) return;
                const parent = renaming.path.slice(0, renaming.path.lastIndexOf('/')) || '';
                renameMutation.mutate({
                  from: renaming.path,
                  to: `${parent}/${renameValue.trim()}`,
                });
              }}
              disabled={!renameValue.trim()}
              loading={renameMutation.isPending}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editing ? (
        <FileEditor
          serverId={server.id}
          path={editing.path}
          initialContent={editing.content}
          readOnly={!writable}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
