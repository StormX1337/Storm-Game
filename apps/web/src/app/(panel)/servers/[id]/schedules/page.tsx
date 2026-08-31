'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock, MoreVertical, Play, Plus, Trash2, X } from 'lucide-react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  cn,
  useConfirm,
  useToast,
} from '@storm/ui';
import type { ScheduleAction, ScheduleSummary } from '@storm/types';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { useServer } from '@/components/panel/server-context';

interface ScheduleWithDescription extends ScheduleSummary {
  description: string;
}

const ACTIONS: { value: ScheduleAction; label: string; needsPayload?: string }[] = [
  { value: 'POWER_START', label: 'Start the server' },
  { value: 'POWER_STOP', label: 'Stop the server' },
  { value: 'POWER_RESTART', label: 'Restart the server' },
  { value: 'POWER_KILL', label: 'Kill the server' },
  {
    value: 'COMMAND',
    label: 'Send a console command',
    needsPayload: 'say Restarting in 5 minutes',
  },
  { value: 'BACKUP', label: 'Create a backup', needsPayload: 'Optional backup name' },
  { value: 'NOTIFY', label: 'Send a notification', needsPayload: 'Message to send' },
];

/** Ready-made cadences: most schedules are one of these. */
const PRESETS = [
  {
    label: 'Every day at 04:00',
    cron: { minute: '0', hour: '4', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  },
  {
    label: 'Every 6 hours',
    cron: { minute: '0', hour: '*/6', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  },
  {
    label: 'Every hour',
    cron: { minute: '0', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  },
  {
    label: 'Every 30 minutes',
    cron: { minute: '*/30', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  },
  {
    label: 'Weekly on Sunday at 03:00',
    cron: { minute: '0', hour: '3', dayOfMonth: '*', month: '*', dayOfWeek: '0' },
  },
];

interface TaskDraft {
  action: ScheduleAction;
  payload: string;
  timeOffsetSec: number;
  continueOnFailure: boolean;
}

export default function SchedulesPage() {
  const { server, can } = useServer();
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();

  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ScheduleWithDescription | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['server', server.shortId, 'schedules'],
    queryFn: () => api.get<ScheduleWithDescription[]>(`/servers/${server.id}/schedules`),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['server', server.shortId, 'schedules'] });
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${server.id}/schedules/${id}`),
    onSuccess: () => {
      toast.success('Schedule deleted');
      invalidate();
    },
    onError: (error) => toast.error('Delete failed', errorMessage(error)),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.post(`/servers/${server.id}/schedules/${id}/run`, {}),
    onSuccess: () => toast.success('Schedule queued', 'It will run in the background.'),
    onError: (error) => toast.error('Could not run schedule', errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      api.patch(`/servers/${server.id}/schedules/${input.id}`, { isActive: input.active }),
    onSuccess: invalidate,
    onError: (error) => toast.error('Could not update schedule', errorMessage(error)),
  });

  const manage = can('servers.schedules.manage') && !server.suspended;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Schedules</h2>
          <p className="text-sm text-muted-foreground">
            Automate restarts, backups and commands on a cron cadence.
          </p>
        </div>
        {manage ? (
          <Button
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            <Plus />
            New schedule
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-28" />
          ))}
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid gap-3">
          {data.map((schedule) => (
            <Card key={schedule.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate font-semibold">{schedule.name}</h3>
                    <Badge variant={schedule.isActive ? 'success' : 'muted'}>
                      {schedule.isActive ? 'Active' : 'Paused'}
                    </Badge>
                    {schedule.onlyWhenOnline ? (
                      <Badge variant="secondary">Only when online</Badge>
                    ) : null}
                  </div>
                  <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {schedule.description}
                    <span className="font-mono text-xs">
                      ({schedule.cron.minute} {schedule.cron.hour} {schedule.cron.dayOfMonth}{' '}
                      {schedule.cron.month} {schedule.cron.dayOfWeek})
                    </span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {manage ? (
                    <Switch
                      checked={schedule.isActive}
                      onCheckedChange={(checked) =>
                        toggle.mutate({ id: schedule.id, active: checked })
                      }
                      aria-label="Toggle schedule"
                    />
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Schedule actions">
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {manage ? (
                        <>
                          <DropdownMenuItem onSelect={() => runNow.mutate(schedule.id)}>
                            <Play />
                            Run now
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setEditing(schedule);
                              setOpen(true);
                            }}
                          >
                            <CalendarClock />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            destructive
                            onSelect={() => {
                              void confirm({
                                title: `Delete "${schedule.name}"?`,
                                description: 'The schedule and its tasks are removed permanently.',
                                confirmLabel: 'Delete',
                                destructive: true,
                              }).then((confirmed) => {
                                if (confirmed) remove.mutate(schedule.id);
                              });
                            }}
                          >
                            <Trash2 />
                            Delete
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {schedule.tasks.map((task, index) => (
                  <span
                    key={task.id}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs',
                      task.lastError && 'border-destructive/40 text-destructive',
                    )}
                  >
                    <span className="font-mono text-muted-foreground">{index + 1}</span>
                    {ACTIONS.find((entry) => entry.value === task.action)?.label ?? task.action}
                    {task.timeOffsetSec > 0 ? (
                      <span className="text-muted-foreground">+{task.timeOffsetSec}s</span>
                    ) : null}
                  </span>
                ))}
              </div>

              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                <span>
                  Last run: {schedule.lastRunAt ? formatRelative(schedule.lastRunAt) : 'never'}
                </span>
                <span>Next run: {schedule.nextRunAt ? formatDate(schedule.nextRunAt) : '—'}</span>
                <span>Timezone: {schedule.timezone}</span>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={CalendarClock}
            title="No schedules yet"
            description="Set up an automatic nightly restart or a backup every few hours."
            action={
              manage ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null);
                    setOpen(true);
                  }}
                >
                  <Plus />
                  New schedule
                </Button>
              ) : null
            }
          />
        </Card>
      )}

      {open ? (
        <ScheduleDialog
          serverId={server.id}
          schedule={editing}
          onClose={() => {
            setOpen(false);
            setEditing(null);
          }}
          onSaved={() => {
            invalidate();
            setOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ScheduleDialog({
  serverId,
  schedule,
  onClose,
  onSaved,
}: {
  serverId: string;
  schedule: ScheduleWithDescription | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();

  const [name, setName] = React.useState(schedule?.name ?? '');
  const [cron, setCron] = React.useState(
    schedule?.cron ?? { minute: '0', hour: '4', dayOfMonth: '*', month: '*', dayOfWeek: '*' },
  );
  const [timezone, setTimezone] = React.useState(
    schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );
  const [onlyWhenOnline, setOnlyWhenOnline] = React.useState(schedule?.onlyWhenOnline ?? false);
  const [isActive, setIsActive] = React.useState(schedule?.isActive ?? true);
  const [tasks, setTasks] = React.useState<TaskDraft[]>(
    schedule?.tasks.map((task) => ({
      action: task.action,
      payload: task.payload,
      timeOffsetSec: task.timeOffsetSec,
      continueOnFailure: task.continueOnFailure,
    })) ?? [{ action: 'POWER_RESTART', payload: '', timeOffsetSec: 0, continueOnFailure: false }],
  );

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        cronMinute: cron.minute,
        cronHour: cron.hour,
        cronDayOfMonth: cron.dayOfMonth,
        cronMonth: cron.month,
        cronDayOfWeek: cron.dayOfWeek,
        timezone,
        isActive,
        onlyWhenOnline,
        tasks,
      };
      return schedule
        ? api.patch(`/servers/${serverId}/schedules/${schedule.id}`, payload)
        : api.post(`/servers/${serverId}/schedules`, payload);
    },
    onSuccess: () => {
      toast.success(schedule ? 'Schedule updated' : 'Schedule created');
      onSaved();
    },
    onError: (error) => toast.error('Could not save schedule', errorMessage(error)),
  });

  const updateTask = (index: number, patch: Partial<TaskDraft>): void => {
    setTasks((current) => current.map((task, i) => (i === index ? { ...task, ...patch } : task)));
  };

  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule ? 'Edit schedule' : 'New schedule'}</DialogTitle>
          <DialogDescription>
            Tasks run in order. An offset waits that many seconds before the task starts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Name" required>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nightly restart"
              autoFocus
            />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium">When should it run?</p>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => {
                const active =
                  cron.minute === preset.cron.minute &&
                  cron.hour === preset.cron.hour &&
                  cron.dayOfWeek === preset.cron.dayOfWeek;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setCron(preset.cron)}
                    className={cn(
                      'rounded-lg border px-2.5 py-1 text-xs transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-secondary',
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-5 gap-2 pt-1">
              {(
                [
                  ['minute', 'Minute'],
                  ['hour', 'Hour'],
                  ['dayOfMonth', 'Day'],
                  ['month', 'Month'],
                  ['dayOfWeek', 'Weekday'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    value={cron[key]}
                    onChange={(event) =>
                      setCron((current) => ({ ...current, [key]: event.target.value }))
                    }
                    className="text-center font-mono"
                  />
                </Field>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Tasks</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setTasks((current) => [
                    ...current,
                    { action: 'COMMAND', payload: '', timeOffsetSec: 0, continueOnFailure: false },
                  ])
                }
              >
                <Plus />
                Add task
              </Button>
            </div>

            {tasks.map((task, index) => {
              const meta = ACTIONS.find((entry) => entry.value === task.action);
              return (
                <Card key={index} className="p-3">
                  <div className="flex items-start gap-2">
                    <span className="mt-2 font-mono text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <Select
                        value={task.action}
                        onValueChange={(value) =>
                          updateTask(index, { action: value as ScheduleAction })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ACTIONS.map((entry) => (
                            <SelectItem key={entry.value} value={entry.value}>
                              {entry.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {meta?.needsPayload ? (
                        <Input
                          value={task.payload}
                          onChange={(event) => updateTask(index, { payload: event.target.value })}
                          placeholder={meta.needsPayload}
                          className="font-mono text-xs"
                        />
                      ) : null}

                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={86400}
                          value={task.timeOffsetSec}
                          onChange={(event) =>
                            updateTask(index, { timeOffsetSec: Number(event.target.value) || 0 })
                          }
                          className="h-8 w-24 text-xs"
                        />
                        <span className="text-xs text-muted-foreground">seconds offset</span>
                      </div>
                    </div>

                    {tasks.length > 1 ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setTasks((current) => current.filter((_, i) => i !== index))}
                        aria-label="Remove task"
                      >
                        <X />
                      </Button>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Timezone">
              <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
            </Field>
            <div className="space-y-3 pt-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={onlyWhenOnline} onCheckedChange={setOnlyWhenOnline} />
                Only run when the server is online
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={isActive} onCheckedChange={setIsActive} />
                Active
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim()} loading={save.isPending}>
            {schedule ? 'Save changes' : 'Create schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
