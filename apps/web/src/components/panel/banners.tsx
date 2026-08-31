'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Info, Megaphone, Wrench, X } from 'lucide-react';
import { cn } from '@storm/ui';
import {
  usePanelSettings,
  useWorksDuringMaintenance,
  type AnnouncementLevel,
} from '@/lib/panel-settings';

const LEVEL_STYLES: Record<AnnouncementLevel, { wrapper: string; icon: typeof Info }> = {
  info: { wrapper: 'border-primary/30 bg-primary/10 text-foreground', icon: Megaphone },
  warning: { wrapper: 'border-warning/40 bg-warning/10 text-foreground', icon: AlertTriangle },
  critical: {
    wrapper: 'border-destructive/40 bg-destructive/10 text-foreground',
    icon: AlertTriangle,
  },
};

const DISMISSED_KEY = 'storm.announcement.dismissed';

/**
 * The announcement an administrator set in the panel settings.
 *
 * Dismissal is remembered per message rather than per person-forever: the key
 * is derived from the text, so putting up a *new* announcement shows it again
 * to everyone who closed the last one. That is the whole point of the feature —
 * an announcement nobody sees is worse than none.
 */
export function AnnouncementBanner() {
  const { announcement, announcementLevel } = usePanelSettings();
  const key = React.useMemo(() => fingerprint(announcement), [announcement]);
  const [dismissed, setDismissed] = React.useState(true);

  React.useEffect(() => {
    if (!announcement) return;
    // Read in an effect, not in render: localStorage does not exist while the
    // page is being prerendered, and reading it during render would make the
    // server and the browser disagree about what to paint.
    setDismissed(readDismissed() === key);
  }, [announcement, key]);

  if (!announcement || dismissed) return null;

  const style = LEVEL_STYLES[announcementLevel] ?? LEVEL_STYLES.info;
  const Icon = style.icon;

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b px-4 py-3 text-sm sm:px-6 lg:px-8',
        style.wrapper,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
        {announcement}
      </p>
      <button
        type="button"
        aria-label="Dismiss announcement"
        className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        onClick={() => {
          writeDismissed(key);
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Reminds an administrator that maintenance mode is still on.
 *
 * They are the only people who can still use the panel while it is, which is
 * exactly why they are the ones who forget. Customers never see this — they
 * are looking at the maintenance screen instead.
 */
export function MaintenanceBanner() {
  const { maintenanceMode } = usePanelSettings();
  const stillWorking = useWorksDuringMaintenance();
  if (!maintenanceMode || !stillWorking) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-sm sm:px-6 lg:px-8"
    >
      <Wrench className="h-4 w-4 shrink-0 text-warning" />
      <span className="font-medium">Maintenance mode is on.</span>
      <span className="text-muted-foreground">
        Customers cannot reach the panel or their servers.
      </span>
      <Link
        href="/admin/settings"
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        Turn it off
      </Link>
    </div>
  );
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    // Private windows and blocked site data both throw here. Showing the
    // announcement again is the harmless side of that failure.
    return null;
  }
}

function writeDismissed(key: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, key);
  } catch {
    // Nothing to do: it stays dismissed for this page view only.
  }
}

/** A short, stable stand-in for the message text. */
export function fingerprint(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
