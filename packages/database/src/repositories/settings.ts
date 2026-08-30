import type { PrismaClient } from '@prisma/client';

/** Panel settings with their defaults. Persisted as JSON rows in `settings`. */
export interface PanelSettings {
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

export const DEFAULT_SETTINGS: PanelSettings = {
  panelName: 'Storm Panel',
  panelUrl: 'http://localhost:3000',
  supportEmail: 'support@localhost',
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

const PUBLIC_KEYS: (keyof PanelSettings)[] = [
  'panelName',
  'panelUrl',
  'registrationEnabled',
  'requireEmailVerification',
  'maintenanceMode',
  'maintenanceMessage',
  'supportEmail',
];

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
          isPublic: PUBLIC_KEYS.includes(key as keyof PanelSettings),
        },
        update: { value: value as never },
      }),
    ),
  );
  return readSettings(prisma);
}

export function publicSettings(settings: PanelSettings): Partial<PanelSettings> {
  const out: Partial<PanelSettings> = {};
  for (const key of PUBLIC_KEYS) {
    (out as unknown as Record<string, unknown>)[key] = settings[key];
  }
  return out;
}
