'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@storm/types';
import { api } from './api';
import { useAuth } from './auth-context';

export type AnnouncementLevel = 'info' | 'warning' | 'critical';

/** The settings `GET /settings` serves to anyone, signed in or not. */
export interface PublicPanelSettings {
  panelName: string;
  panelUrl: string;
  brandColor: string;
  announcement: string;
  announcementLevel: AnnouncementLevel;
  registrationEnabled: boolean;
  requireEmailVerification: boolean;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  supportEmail: string;
}

/**
 * What the panel looks like before the API has answered.
 *
 * These are the same values the API defaults to, so the first paint of a
 * freshly installed panel is already right and a rebrand only ever changes
 * things once, on the first response — rather than flashing "Storm Panel" at
 * someone who renamed it.
 */
/** The name the static metadata is written with, and what gets replaced. */
const DEFAULT_PANEL_NAME = 'Storm Panel';

const FALLBACK: PublicPanelSettings = {
  panelName: DEFAULT_PANEL_NAME,
  panelUrl: '',
  brandColor: '#2563eb',
  announcement: '',
  announcementLevel: 'info',
  registrationEnabled: true,
  requireEmailVerification: false,
  maintenanceMode: false,
  maintenanceMessage: '',
  supportEmail: '',
};

const PanelSettingsContext = React.createContext<PublicPanelSettings>(FALLBACK);

export function usePanelSettings(): PublicPanelSettings {
  return React.useContext(PanelSettingsContext);
}

export function PanelSettingsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { data } = useQuery({
    queryKey: ['panel-settings'],
    queryFn: () => api.get<PublicPanelSettings>('/settings'),
    // Branding rarely changes, but maintenance mode does, and the panel has to
    // notice it going on *and off* without the customer reloading the page.
    staleTime: 15_000,
    // Someone staring at the maintenance screen is waiting for exactly this
    // answer to change, so ask more often while they are locked out. The rest
    // of the time a minute is plenty for a setting that moves once a month.
    refetchInterval: (query) => (query.state.data?.maintenanceMode ? 10_000 : 60_000),
    refetchOnWindowFocus: true,
  });

  const settings = data ?? FALLBACK;

  useBrandColor(settings.brandColor);
  useDocumentTitle(settings.panelName);

  return <PanelSettingsContext.Provider value={settings}>{children}</PanelSettingsContext.Provider>;
}

/**
 * Whether maintenance mode is shutting this viewer out, and what to tell them.
 *
 * The rule mirrors the API's exactly — `admin.dashboard`, which `can` already
 * widens to the owner. Not `isAdmin`: that also counts `admin.servers`, so a
 * role holding only that one would be shown a working panel here and then get
 * 503 from every request it made. A client-side gate that disagrees with the
 * server is worse than none.
 */
export function useMaintenanceLockout(): { locked: boolean; message: string } {
  const { maintenanceMode, maintenanceMessage } = usePanelSettings();
  const { can } = useAuth();
  return {
    locked: maintenanceMode && !can(Permission.ADMIN_DASHBOARD),
    message: maintenanceMessage,
  };
}

/** Whether this viewer keeps working while maintenance mode is on. */
export function useWorksDuringMaintenance(): boolean {
  const { can } = useAuth();
  return can(Permission.ADMIN_DASHBOARD);
}

/**
 * Repaints the design tokens the brand colour drives.
 *
 * The palette is stored as HSL triplets so Tailwind can vary opacity
 * (`hsl(var(--primary) / 0.4)`), which means an admin's hex has to be
 * converted rather than assigned. Setting the variables on the root element
 * overrides both the light and dark blocks in the stylesheet, so one colour
 * covers both themes.
 */
function useBrandColor(hex: string): void {
  React.useEffect(() => {
    const hsl = hexToHslTriplet(hex);
    const root = document.documentElement;
    if (!hsl) {
      // A colour the API would have rejected: leave the stylesheet's own
      // tokens in place rather than writing something unusable into them.
      for (const token of ['--primary', '--accent', '--ring']) root.style.removeProperty(token);
      return;
    }
    for (const token of ['--primary', '--accent', '--ring']) root.style.setProperty(token, hsl);
  }, [hex]);
}

/**
 * Keeps the browser tab in sync with a renamed panel.
 *
 * The titles come from Next's static metadata, which is rendered on the server
 * — where the panel's name is not known, because it lives in the database and
 * the web app talks to the API only from the browser. So the name is swapped
 * in after each navigation, once the new title has been committed.
 */
function useDocumentTitle(panelName: string): void {
  const pathname = usePathname();
  React.useEffect(() => {
    if (!panelName || panelName === DEFAULT_PANEL_NAME) return;
    document.title = document.title.split(DEFAULT_PANEL_NAME).join(panelName);
  }, [panelName, pathname]);
}

/** `#2563eb` → `221 83% 53%`, the form the design tokens are stored in. */
export function hexToHslTriplet(hex: string): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;

  const value = Number.parseInt(match[1], 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return `${Math.round(hue)} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`;
}
