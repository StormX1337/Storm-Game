'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Check,
  LogOut,
  Menu,
  Moon,
  Search,
  Server,
  Sun,
  User as UserIcon,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from '@storm/ui';
import type { NotificationView, ServerSummary } from '@storm/types';
import { api, apiPaginated } from '@/lib/api';
import { formatRelative, initials } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { useAccountSocket } from '@/hooks/use-account-socket';

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const { user, signOut } = useAuth();
  const { connected } = useAccountSocket();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // Theme is only known after hydration; render a stable icon until then.
  React.useEffect(() => setMounted(true), []);

  const displayName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username
    : '';

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <ServerSearch />

      <div className="ml-auto flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs sm:flex',
                connected ? 'text-muted-foreground' : 'text-warning',
              )}
            >
              {connected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {connected ? 'Live' : 'Reconnecting'}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {connected
              ? 'Receiving realtime updates'
              : 'Realtime connection lost — retrying automatically'}
          </TooltipContent>
        </Tooltip>

        <NotificationBell />

        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label="Toggle colour theme"
        >
          {mounted && resolvedTheme === 'light' ? <Sun /> : <Moon />}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              // Below `sm` only the avatar shows, so the button needs a name of
              // its own or it announces as a pair of initials.
              aria-label="Account menu"
              className="flex items-center gap-2 rounded-lg p-1 pl-2 transition-colors hover:bg-secondary/70"
            >
              <span className="hidden text-sm font-medium sm:block">{displayName}</span>
              <Avatar className="h-8 w-8">
                <AvatarFallback>{initials(displayName || 'S')}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <span className="block truncate text-sm font-medium normal-case tracking-normal text-foreground">
                {displayName}
              </span>
              <span className="block truncate text-xs font-normal normal-case tracking-normal text-muted-foreground">
                {user?.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account">
                <UserIcon />
                Account settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/account/security">
                <Check />
                Security
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => void signOut()}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** Type-ahead over the user's servers, opened with the keyboard or the field. */
function ServerSearch() {
  const router = useRouter();
  const [term, setTerm] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { data } = useQuery({
    queryKey: ['servers', 'search', term],
    queryFn: () => apiPaginated<ServerSummary>('/servers', { query: { search: term, perPage: 6 } }),
    enabled: open && term.trim().length > 0,
    staleTime: 10_000,
  });

  return (
    <div className="relative max-w-md flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search servers…"
        className="pl-9 pr-16"
        aria-label="Quick search"
      />
      <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground sm:block">
        ⌘K
      </kbd>

      {open && term.trim().length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-lg border border-border bg-popover shadow-xl">
          {data?.items.length ? (
            data.items.map((server) => (
              <button
                key={server.id}
                type="button"
                onMouseDown={() => {
                  router.push(`/servers/${server.shortId}`);
                  setTerm('');
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary"
              >
                <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{server.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {server.node.name} · {server.template?.game ?? 'Custom'}
                  </span>
                </span>
                <Badge variant="muted">{server.status.toLowerCase()}</Badge>
              </button>
            ))
          ) : (
            <p className="px-3 py-4 text-sm text-muted-foreground">No servers match that search.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface NotificationsPayload {
  items: NotificationView[];
  unread: number;
  total: number;
}

function NotificationBell() {
  const queryClient = useQueryClient();
  const { unreadCount, setUnreadCount } = useAccountSocket();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<NotificationsPayload>('/account/notifications', { query: { perPage: 10 } }),
    refetchInterval: 120_000,
  });

  React.useEffect(() => {
    if (data) setUnreadCount(data.unread);
  }, [data, setUnreadCount]);

  const markAllRead = async (): Promise<void> => {
    await api.post('/account/notifications/read', {});
    setUnreadCount(0);
    await queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell />
          {unreadCount > 0 ? (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-bold text-primary-foreground">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="text-xs font-medium text-primary hover:underline"
            >
              Mark all read
            </button>
          ) : null}
        </div>

        <ScrollArea className="max-h-96">
          {data?.items.length ? (
            data.items.map((notification) => (
              <div
                key={notification.id}
                className={cn(
                  'border-b border-border px-4 py-3 last:border-0',
                  !notification.read && 'bg-primary/[0.04]',
                )}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      notification.level === 'ERROR' && 'bg-destructive',
                      notification.level === 'WARNING' && 'bg-warning',
                      notification.level === 'SUCCESS' && 'bg-success',
                      notification.level === 'INFO' && 'bg-primary',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-snug">{notification.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {notification.message}
                    </p>
                    <p className="mt-1 text-2xs text-muted-foreground">
                      {formatRelative(notification.createdAt)}
                    </p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              Nothing to report right now.
            </p>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
