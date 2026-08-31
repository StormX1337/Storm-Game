'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus, Users, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Label,
  Skeleton,
  useConfirm,
  useToast,
} from '@storm/ui';
import { CUSTOMER_PERMISSIONS } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { useServer } from '@/components/panel/server-context';
import { useAuth } from '@/lib/auth-context';

interface Subuser {
  id: string;
  userId: string;
  username: string;
  email: string;
  permissions: string[];
  createdAt: string;
}

export default function SubusersPage() {
  const { server, can } = useServer();
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const allowed = can('servers.subusers');
  const manage = allowed && !server.suspended;

  const subusers = useQuery({
    queryKey: ['server', server.shortId, 'subusers'],
    queryFn: () => api.get<Subuser[]>(`/servers/${server.id}/subusers`),
    enabled: allowed,
  });

  const removeSubuser = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/subusers/${id}`),
    onSuccess: () => {
      toast.success('Access removed');
      void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'subusers'] });
    },
    onError: (error) => toast.error('Could not remove access', errorMessage(error)),
  });

  async function onRemove(subuser: Subuser): Promise<void> {
    const confirmed = await confirm({
      title: `Remove ${subuser.username}?`,
      description: 'They lose access to this server immediately, including any open console.',
      confirmLabel: 'Remove access',
      destructive: true,
    });
    if (confirmed) removeSubuser.mutate(subuser.id);
  }

  if (!allowed) {
    return (
      <EmptyState
        icon={Users}
        title="No access to sharing"
        description="Your access to this server does not include managing who else can reach it."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Shared access</CardTitle>
            <CardDescription>
              Give someone else scoped access without handing over your account. You can only grant
              what you hold yourself.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setInviteOpen(true)} disabled={!manage}>
            <UserPlus />
            Add user
          </Button>
        </CardHeader>
        <CardContent>
          {subusers.isLoading ? (
            <Skeleton className="h-20" />
          ) : subusers.data && subusers.data.length > 0 ? (
            <div className="space-y-2">
              {subusers.data.map((subuser) => (
                <div
                  key={subuser.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{subuser.username}</p>
                    <p className="truncate text-xs text-muted-foreground">{subuser.email}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {subuser.permissions.slice(0, 6).map((permission) => (
                        <Badge key={permission} variant="secondary" className="text-2xs">
                          {permission.replace('servers.', '')}
                        </Badge>
                      ))}
                      {subuser.permissions.length > 6 ? (
                        <Badge variant="muted" className="text-2xs">
                          +{subuser.permissions.length - 6}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive"
                    aria-label={`Remove ${subuser.username}`}
                    onClick={() => void onRemove(subuser)}
                    disabled={!manage}
                  >
                    <X />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Users}
              title="Nobody else has access"
              description="Invite a teammate and pick exactly what they may do."
            />
          )}
        </CardContent>
      </Card>

      {inviteOpen ? (
        <InviteDialog
          serverId={server.id}
          available={user?.permissions ?? []}
          onClose={() => setInviteOpen(false)}
          onSaved={() => {
            setInviteOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'subusers'] });
          }}
        />
      ) : null}
    </div>
  );
}

function InviteDialog({
  serverId,
  available,
  onClose,
  onSaved,
}: {
  serverId: string;
  available: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = React.useState('');
  const [permissions, setPermissions] = React.useState<Set<string>>(
    () => new Set(['servers.view', 'servers.console']),
  );

  // Only offer permissions the inviter actually holds — the API enforces this
  // too, but showing the real set avoids a confusing rejection.
  const grantable = CUSTOMER_PERMISSIONS.filter((permission) => available.includes(permission));

  const invite = useMutation({
    mutationFn: () =>
      api.post(`/servers/${serverId}/subusers`, {
        email: email.trim(),
        permissions: [...permissions],
      }),
    onSuccess: () => {
      toast.success('Access granted');
      onSaved();
    },
    onError: (error) => toast.error('Could not grant access', errorMessage(error)),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this server</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Email address" hint="They must already have a Storm Panel account." required>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teammate@example.com"
              autoFocus
            />
          </Field>

          <div className="space-y-2">
            <Label>Permissions</Label>
            <div className="grid max-h-64 gap-1.5 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
              {grantable.map((permission) => (
                <label key={permission} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={permissions.has(permission)}
                    onCheckedChange={(checked) =>
                      setPermissions((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(permission);
                        else next.delete(permission);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-xs">{permission.replace('servers.', '')}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => invite.mutate()}
            disabled={!email.trim() || permissions.size === 0}
            loading={invite.isPending}
          >
            Grant access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
