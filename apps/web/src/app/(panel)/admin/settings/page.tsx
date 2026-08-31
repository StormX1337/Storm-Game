'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Palette, Save, Send, Settings2 } from 'lucide-react';
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
  Skeleton,
  Switch,
  Textarea,
  useToast,
} from '@storm/ui';
import { api, errorMessage } from '@/lib/api';

type AnnouncementLevel = 'info' | 'warning' | 'critical';

interface PanelSettings {
  panelName: string;
  panelUrl: string;
  supportEmail: string;
  brandColor: string;
  announcement: string;
  announcementLevel: AnnouncementLevel;
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
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<PanelSettings | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<PanelSettings>('/admin/settings'),
  });

  React.useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const testMail = useMutation({
    mutationFn: () => api.post<{ sentTo: string; tookMs: number }>('/admin/settings/mail/test', {}),
    onSuccess: (result) =>
      toast.success('Email sent', `Delivered to ${result.sentTo} in ${result.tookMs} ms.`),
    // The SMTP error is the useful part, so it goes through unedited.
    onError: (error) => toast.error('Could not send the test', errorMessage(error)),
  });

  const save = useMutation({
    mutationFn: () => api.patch<PanelSettings>('/admin/settings', form ?? {}),
    onSuccess: (result) => {
      setForm(result);
      // The name and colour are read from the public settings query, which the
      // whole panel shares. Without this the administrator saves a rebrand and
      // watches nothing change for half a minute.
      void queryClient.invalidateQueries({ queryKey: ['panel-settings'] });
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
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-primary" />
            Branding
          </CardTitle>
          <CardDescription>
            The name is used everywhere the panel refers to itself, sign-in page included. The
            colour drives buttons, links and highlights in both themes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Field
            label="Accent colour"
            hint="Six-digit hex. Pick something with enough contrast to read white text on."
          >
            <div className="flex items-center gap-3">
              <input
                type="color"
                aria-label="Accent colour"
                value={validHex(form.brandColor) ? form.brandColor : '#2563eb'}
                onChange={(event) => set('brandColor', event.target.value)}
                className="h-10 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
              />
              <Input
                value={form.brandColor}
                onChange={text('brandColor')}
                placeholder="#2563eb"
                className="max-w-[160px] font-mono"
                aria-invalid={!validHex(form.brandColor)}
              />
              <Button variant="ghost" size="sm" onClick={() => set('brandColor', '#2563eb')}>
                Reset
              </Button>
            </div>
          </Field>
          {validHex(form.brandColor) ? null : (
            <p className="mt-2 text-sm text-destructive">
              That is not a six-digit hex colour — saving will be rejected.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" />
            Announcement
          </CardTitle>
          <CardDescription>
            Shown as a banner above every page in the panel. Leave it empty for no banner. Anyone
            who dismisses it sees the next one you write.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Message" hint={`${form.announcement.length}/500 characters`}>
            <Textarea
              rows={3}
              maxLength={500}
              value={form.announcement}
              onChange={(event) => set('announcement', event.target.value)}
              placeholder="Scheduled maintenance on Saturday from 20:00 UTC — expect around 30 minutes of downtime."
            />
          </Field>
          <Field label="Severity" hint="Only changes how the banner looks.">
            <Select
              value={form.announcementLevel}
              onValueChange={(value) => set('announcementLevel', value as AnnouncementLevel)}
            >
              <SelectTrigger className="max-w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Information</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
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
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Email</CardTitle>
            <CardDescription>
              Verification and password-reset links go out over SMTP. Without it the panel still
              works and writes the links to the API log instead.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMail.mutate()}
            loading={testMail.isPending}
          >
            <Send />
            Send test email
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The test goes to your own address only. If SMTP is misconfigured you get the
            server&apos;s own error back — which is what tells you whether it is the credentials,
            the port or the hostname.
          </p>
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
            <Input
              type="number"
              value={form.defaultServerLimit}
              onChange={number('defaultServerLimit')}
            />
          </Field>
          <Field label="Memory (MiB)">
            <Input
              type="number"
              value={form.defaultMemoryLimit}
              onChange={number('defaultMemoryLimit')}
            />
          </Field>
          <Field label="Disk (MiB)">
            <Input
              type="number"
              value={form.defaultDiskLimit}
              onChange={number('defaultDiskLimit')}
            />
          </Field>
          <Field label="Backups per server">
            <Input
              type="number"
              value={form.defaultBackupLimit}
              onChange={number('defaultBackupLimit')}
            />
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
            hint="The default for every backup storage that has not set its own. Backups older than this are pruned; zero keeps them forever, and a locked backup is never pruned whatever this says."
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
            Locks customers out of the panel and shows them a notice instead. Their servers keep
            running throughout — this stops people using the panel, not the containers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle
            label="Enable maintenance mode"
            description="Anyone who can reach this admin area keeps full access, including you. New sign-ups are refused."
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

/** Mirrors the API's own rule, so the form rejects what the save would. */
function validHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
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
