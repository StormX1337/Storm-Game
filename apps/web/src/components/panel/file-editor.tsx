'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import { useTheme } from 'next-themes';
import { Save, X } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useConfirm,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';

/** Only a handful of languages ship a grammar; everything else is plain text. */
function languageFor(path: string): Extension[] {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'json':
      return [json()];
    case 'yml':
    case 'yaml':
      return [yaml()];
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
      return [javascript({ typescript: extension === 'ts' })];
    default:
      return [];
  }
}

export function FileEditor({
  serverId,
  path,
  initialContent,
  readOnly,
  onClose,
  onSaved,
}: {
  serverId: string;
  path: string;
  initialContent: string;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const { resolvedTheme } = useTheme();

  const [content, setContent] = React.useState(initialContent);
  const dirty = content !== initialContent;

  const save = useMutation({
    mutationFn: () => api.post(`/servers/${serverId}/files/write`, { path, content }),
    onSuccess: () => {
      toast.success('File saved', path);
      onSaved();
      onClose();
    },
    onError: (error) => toast.error('Could not save', errorMessage(error)),
  });

  const requestClose = async (): Promise<void> => {
    if (!dirty) {
      onClose();
      return;
    }
    const confirmed = await confirm({
      title: 'Discard unsaved changes?',
      description: 'Your edits to this file will be lost.',
      confirmLabel: 'Discard',
      destructive: true,
    });
    if (confirmed) onClose();
  };

  // Ctrl/Cmd+S saves, which is the muscle memory anyone editing a config has.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!readOnly && dirty) save.mutate();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, dirty, save]);

  return (
    <Dialog open onOpenChange={(open) => !open && void requestClose()}>
      <DialogContent
        className="flex h-[85vh] max-w-5xl flex-col gap-0 overflow-hidden p-0"
        hideClose
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          void requestClose();
        }}
      >
        <DialogHeader className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <DialogTitle className="truncate font-mono text-sm">{path}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {formatBytes(new Blob([content]).size)}
              {dirty ? ' · unsaved changes' : ''}
              {readOnly ? ' · read only' : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!readOnly ? (
              <Button size="sm" onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
                <Save />
                Save
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" onClick={() => void requestClose()} aria-label="Close">
              <X />
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-auto">
          <CodeMirror
            value={content}
            onChange={setContent}
            extensions={languageFor(path)}
            theme={resolvedTheme === 'light' ? undefined : oneDark}
            editable={!readOnly}
            height="100%"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: true,
              bracketMatching: true,
              autocompletion: false,
              highlightSelectionMatches: true,
            }}
            style={{ fontSize: 13, height: '100%' }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
