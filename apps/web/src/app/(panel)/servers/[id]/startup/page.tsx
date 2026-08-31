'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Info, Save, Terminal } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@storm/ui';
import type { ServerDetail } from '@storm/types';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useServer } from '@/components/panel/server-context';

export default function StartupPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [command, setCommand] = React.useState(server.startupCommand);
  const [image, setImage] = React.useState(server.dockerImage);
  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(server.variables.map((variable) => [variable.key, variable.value])),
  );
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string[]>>({});

  const editable = can('servers.startup') && !server.suspended;
  const variablesEditable = can('servers.variables') && !server.suspended;

  const images = React.useMemo(() => {
    // Only what the template declares, so a customer cannot point their
    // container at an arbitrary registry — the API enforces the same list.
    // The server's current image is included even if the template has since
    // dropped it, so the selector always shows what is actually running.
    const declared = server.template?.dockerImages ?? {};
    const byImage = new Map<string, string>();
    for (const [label, image] of Object.entries(declared)) byImage.set(image, label);
    if (!byImage.has(server.dockerImage)) byImage.set(server.dockerImage, server.dockerImage);
    return [...byImage].map(([image, label]) => ({ image, label }));
  }, [server.dockerImage, server.template]);

  const saveStartup = useMutation({
    mutationFn: () =>
      api.patch<ServerDetail>(`/servers/${server.id}/startup`, {
        startupCommand: command,
        dockerImage: image,
      }),
    onSuccess: () => {
      toast.success('Startup updated', 'Restart the server to apply it.');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
    },
    onError: (error) => toast.error('Could not save', errorMessage(error)),
  });

  const saveVariables = useMutation({
    mutationFn: () =>
      api.put<ServerDetail>(`/servers/${server.id}/variables`, { variables: values }),
    onSuccess: () => {
      setFieldErrors({});
      toast.success('Variables saved', 'Restart the server to apply them.');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details) setFieldErrors(error.details);
      toast.error('Could not save variables', errorMessage(error));
    },
  });

  const dirtyVariables = server.variables.some(
    (variable) => values[variable.key] !== variable.value,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Startup command</CardTitle>
          <CardDescription>
            Placeholders like <code className="font-mono text-xs">{'{{SERVER_PORT}}'}</code> are
            replaced with the values below when the container starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Command">
            <div className="relative">
              <Terminal className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <textarea
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!editable}
                rows={3}
                className="flex w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              />
            </div>
          </Field>

          <Field label="Docker image">
            <Select
              value={image}
              onValueChange={setImage}
              disabled={!editable || images.length <= 1}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {images.map((entry) => (
                  <SelectItem key={entry.image} value={entry.image}>
                    {entry.label === entry.image ? (
                      entry.image
                    ) : (
                      <span className="flex items-baseline gap-2">
                        {entry.label}
                        <span className="font-mono text-2xs text-muted-foreground">
                          {entry.image}
                        </span>
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {editable ? (
            <div className="flex justify-end">
              <Button
                onClick={() => saveStartup.mutate()}
                loading={saveStartup.isPending}
                disabled={command === server.startupCommand && image === server.dockerImage}
              >
                <Save />
                Save startup
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Variables</CardTitle>
          <CardDescription>
            Settings this game template exposes. Locked entries are managed by an administrator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {server.variables.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              This template has no configurable variables.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {server.variables.map((variable) => (
                <Field
                  key={variable.key}
                  label={variable.name}
                  hint={variable.description}
                  error={fieldErrors[variable.key]}
                >
                  <Input
                    value={values[variable.key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [variable.key]: event.target.value }))
                    }
                    disabled={!variablesEditable || !variable.editable}
                    className="font-mono text-xs"
                    aria-invalid={Boolean(fieldErrors[variable.key])}
                  />
                  <p className="pt-1 font-mono text-2xs text-muted-foreground">
                    {variable.key}
                    {!variable.editable ? ' · locked' : ''}
                  </p>
                </Field>
              ))}
            </div>
          )}

          {variablesEditable && server.variables.length > 0 ? (
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="h-3.5 w-3.5" />
                Changes take effect the next time the server starts.
              </p>
              <Button
                onClick={() => saveVariables.mutate()}
                loading={saveVariables.isPending}
                disabled={!dirtyVariables}
              >
                <Save />
                Save variables
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
