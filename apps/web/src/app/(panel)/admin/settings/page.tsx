'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Save, Settings2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Skeleton,
  Switch,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';

interface PanelSettings {
  panelName: string;
  panelUrl: string;
  supportEmail: string;
  registrationEnabled: boolean;
  requireEmailVerification: boolean;
  defaultServerLimit: number;
  defaultMemoryLimit: number;
  defaultDiskLimit: number;
  defaultBackupLimit: number;
  defaultDatabaseLimit: number;
  defaultAllocationLimit: number;
  backupRetentionDays: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

export default function AdminSettingsPage() {
  const toast = useToast();
  const [form, setForm] = React.useState<PanelSettings | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<PanelSettings>('/admin/settings'),
  });

  React.useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.patch<PanelSettings>('/admin/settings', form ?? {}),
    onSuccess: (result) => {
      setForm(result);
      toast.success('Settings saved');
    },
    onError: (error) => toast.error('Could not save settings', errorMessage(error)),
  });

  const set = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]): void => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  };

  const number =
    <K extends keyof PanelSettings>(key: K) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      set(key, (Number(event.target.value) || 0) as PanelSettings[K]);
    };

  const text =
    <K extends keyof PanelSettings>(key: K) =>
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      set(key, event.target.value as PanelSettings[K]);
    };

  if (isLoading || !form) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(data);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Panel-wide configuration, applied immediately on save.
          </p>
        </div>
        <Button onClick={() => save.mutate()} disabled={!dirty} loading={save.isPending}>
          <Save />
          Save changes
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Panel name">
              <Input value={form.panelName} onChange={text('panelName')} />
            </Field>
            <Field label="Support email">
              <Input type="email" value={form.supportEmail} onChange={text('supportEmail')} />
            </Field>
          </div>
          <Field
            label="Panel URL"
            hint="Used in emails and the node agent configuration. Must be reachable by nodes."
          >
            <Input value={form.panelUrl} onChange={text('panelUrl')} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registration</CardTitle>
          <CardDescription>Who can create an account and what is required.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            label="Allow public registration"
            description="Turn this off to make the panel invite-only."
            checked={form.registrationEnabled}
            onChange={(value) => set('registrationEnabled', value)}
          />
          <Toggle
            label="Require email verification"
            description="New accounts must confirm their address. Needs SMTP to be configured."
            checked={form.requireEmailVerification}
            onChange={(value) => set('requireEmailVerification', value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default account limits</CardTitle>
          <CardDescription>
            Applied to newly registered accounts. Zero means unlimited.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field label="Servers">
            <Input type="number" value={form.defaultServerLimit} onChange={number('defaultServerLimit')} />
          </Field>
          <Field label="Memory (MiB)">
            <Input type="number" value={form.defaultMemoryLimit} onChange={number('defaultMemoryLimit')} />
          </Field>
          <Field label="Disk (MiB)">
            <Input type="number" value={form.defaultDiskLimit} onChange={number('defaultDiskLimit')} />
          </Field>
          <Field label="Backups per server">
            <Input type="number" value={form.defaultBackupLimit} onChange={number('defaultBackupLimit')} />
          </Field>
          <Field label="Databases per server">
            <Input
              type="number"
              value={form.defaultDatabaseLimit}
              onChange={number('defaultDatabaseLimit')}
            />
          </Field>
          <Field label="Ports per server">
            <Input
              type="number"
              value={form.defaultAllocationLimit}
              onChange={number('defaultAllocationLimit')}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backups</CardTitle>
        </CardHeader>
        <CardContent>
          <Field
            label="Retention (days)"
            hint="Automatic backups older than this are pruned. Zero keeps them forever. Locked backups are never pruned."
          >
            <Input
              type="number"
              value={form.backupRetentionDays}
              onChange={number('backupRetentionDays')}
              className="max-w-[160px]"
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="border-warning/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-warning" />
            Maintenance mode
          </CardTitle>
          <CardDescription>
            Show a notice to customers while you work on the platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            label="Enable maintenance mode"
            description="Administrators keep full access."
            checked={form.maintenanceMode}
            onChange={(value) => set('maintenanceMode', value)}
          />
          <Field label="Message shown to customers">
            <Input value={form.maintenanceMessage} onChange={text('maintenanceMessage')} />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
