import type { PrismaClient } from '@prisma/client';

/** Severity of the announcement banner, lowest to highest. */
export type AnnouncementLevel = 'info' | 'warning' | 'critical';

/** Panel settings with their defaults. Persisted as JSON rows in `settings`. */
export interface PanelSettings {
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

export const DEFAULT_SETTINGS: PanelSettings = {
  panelName: 'Storm Panel',
  panelUrl: 'http://localhost:3000',
  supportEmail: 'support@localhost',
  // The hex form of the default `--primary` token, so an untouched panel looks
  // exactly as it did before branding existed.
  brandColor: '#2563eb',
  announcement: '',
  announcementLevel: 'info',
  registrationEnabled: true,
  requireEmailVerification: false,
  defaultServerLimit: 2,
  defaultMemoryLimit: 4096,
  defaultDiskLimit: 20480,
  defaultBackupLimit: 5,
  defaultDatabaseLimit: 2,
  defaultAllocationLimit: 5,
  backupRetentionDays: 30,
  maintenanceMode: false,
  maintenanceMessage: 'Storm Panel is undergoing maintenance. Please check back soon.',
};

/**
 * Settings served to anyone, signed in or not.
 *
 * The login page has to know the panel's name, its colour and whether
 * registration is open before there is a session to authorise. Everything not
 * listed here — the default limits, the retention policy — stays behind the
 * admin API, because it describes how the panel is run rather than how it
 * looks.
 */
const PUBLIC_KEYS = [
  'panelName',
  'panelUrl',
  'brandColor',
  'announcement',
  'announcementLevel',
  'registrationEnabled',
  'requireEmailVerification',
  'maintenanceMode',
  'maintenanceMessage',
  'supportEmail',
] as const satisfies readonly (keyof PanelSettings)[];

export type PublicSettingKey = (typeof PUBLIC_KEYS)[number];

/** The shape `GET /settings` returns. */
export type PublicPanelSettings = Pick<PanelSettings, PublicSettingKey>;

export async function readSettings(prisma: PrismaClient): Promise<PanelSettings> {
  const rows = await prisma.setting.findMany();
  const settings: PanelSettings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in settings) {
      (settings as unknown as Record<string, unknown>)[row.key] = row.value as unknown;
    }
  }
  return settings;
}

export async function writeSettings(
  prisma: PrismaClient,
  patch: Partial<PanelSettings>,
): Promise<PanelSettings> {
  const entries = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS);
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({
        where: { key },
        create: {
          key,
          value: value as never,
          category: 'general',
          isPublic: (PUBLIC_KEYS as readonly string[]).includes(key),
        },
        update: { value: value as never },
      }),
    ),
  );
  return readSettings(prisma);
}

export function publicSettings(settings: PanelSettings): PublicPanelSettings {
  const out: Partial<PanelSettings> = {};
  for (const key of PUBLIC_KEYS) {
    (out as unknown as Record<string, unknown>)[key] = settings[key];
  }
  return out as PublicPanelSettings;
}
