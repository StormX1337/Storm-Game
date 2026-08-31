/**
 * Idempotent database seed.
 *
 * Running it repeatedly is safe: everything is upserted. It provisions the RBAC
 * tables, the built-in game templates, a default local backup storage target,
 * panel settings and — when ADMIN_* environment variables are present — the
 * first owner account.
 */
import { PrismaClient, RoleName } from '@prisma/client';
import { PERMISSION_DEFINITIONS, ROLE_PERMISSIONS, ROLE_PRIORITY } from '@storm/types';
import { hashPassword } from '@storm/security';
import { SEED_TEMPLATES } from './templates.js';
import { DEFAULT_SETTINGS } from '../repositories/settings.js';

const prisma = new PrismaClient();

const ROLE_META: Record<RoleName, { displayName: string; description: string }> = {
  OWNER: { displayName: 'Owner', description: 'Full control over the panel and its settings.' },
  ADMIN: {
    displayName: 'Administrator',
    description: 'Manages users, nodes, servers and templates.',
  },
  STAFF: { displayName: 'Staff', description: 'Provisions and maintains customer servers.' },
  SUPPORT: { displayName: 'Support', description: 'Read-mostly access for troubleshooting.' },
  CUSTOMER: { displayName: 'Customer', description: 'Manages their own servers.' },
};

async function seedPermissions(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const definition of PERMISSION_DEFINITIONS) {
    const row = await prisma.permission.upsert({
      where: { key: definition.key },
      create: {
        key: definition.key,
        category: definition.category,
        description: definition.description,
      },
      update: { category: definition.category, description: definition.description },
    });
    map.set(row.key, row.id);
  }
  console.log(`  permissions: ${map.size}`);
  return map;
}

async function seedRoles(permissionIds: Map<string, string>): Promise<void> {
  for (const name of Object.keys(ROLE_META) as RoleName[]) {
    const meta = ROLE_META[name];
    const keys = ROLE_PERMISSIONS[name];
    const connect = keys
      .map((key) => permissionIds.get(key))
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id }));

    await prisma.role.upsert({
      where: { name },
      create: {
        name,
        displayName: meta.displayName,
        description: meta.description,
        priority: ROLE_PRIORITY[name],
        isSystem: true,
        permissions: { connect },
      },
      update: {
        displayName: meta.displayName,
        description: meta.description,
        priority: ROLE_PRIORITY[name],
        // `set` keeps role grants in sync when new permissions are introduced.
        permissions: { set: connect },
      },
    });
  }
  console.log(`  roles: ${Object.keys(ROLE_META).length}`);
}

async function seedTemplates(): Promise<void> {
  for (const template of SEED_TEMPLATES) {
    const { variables, ...rest } = template;
    const saved = await prisma.gameTemplate.upsert({
      where: { slug: template.slug },
      create: {
        ...rest,
        dockerImages: rest.dockerImages,
        configFiles: rest.configFiles as object,
        logConfig: rest.logConfig as object,
      },
      update: {
        name: rest.name,
        game: rest.game,
        category: rest.category,
        description: rest.description,
        dockerImages: rest.dockerImages,
        defaultImage: rest.defaultImage,
        startupCommand: rest.startupCommand,
        stopCommand: rest.stopCommand,
        installContainer: rest.installContainer,
        installEntrypoint: rest.installEntrypoint,
        installScript: rest.installScript,
        startupDetection: rest.startupDetection,
        crashDetection: rest.crashDetection,
        defaultPorts: rest.defaultPorts,
        supportedVersions: rest.supportedVersions,
        configFiles: rest.configFiles as object,
        logConfig: rest.logConfig as object,
      },
    });

    for (const variable of variables) {
      await prisma.templateVariable.upsert({
        where: {
          templateId_envVariable: { templateId: saved.id, envVariable: variable.envVariable },
        },
        create: { ...variable, templateId: saved.id },
        update: variable,
      });
    }
  }
  console.log(`  game templates: ${SEED_TEMPLATES.length}`);
}

async function seedBackupStorage(): Promise<void> {
  const existing = await prisma.backupStorage.findFirst({ where: { driver: 'LOCAL' } });
  if (!existing) {
    await prisma.backupStorage.create({
      data: {
        name: 'Local storage',
        driver: 'LOCAL',
        isDefault: true,
        pathPrefix: 'backups',
        isActive: true,
      },
    });
  }
  console.log('  backup storage: ok');
}

async function seedSettings(): Promise<void> {
  const publicKeys = new Set([
    'panelName',
    'panelUrl',
    'registrationEnabled',
    'requireEmailVerification',
    'maintenanceMode',
    'maintenanceMessage',
    'supportEmail',
  ]);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never, isPublic: publicKeys.has(key) },
      update: {},
    });
  }
  console.log(`  settings: ${Object.keys(DEFAULT_SETTINGS).length}`);
}

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL;
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    const owners = await prisma.user.count({ where: { role: { name: 'OWNER' } } });
    if (owners === 0) {
      console.log(
        '  admin: skipped (set ADMIN_EMAIL and ADMIN_PASSWORD, or run `storm admin create`)',
      );
    }
    return;
  }
  if (password.length < 10) {
    throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  }

  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
  const existing = await prisma.user.findFirst({
    where: { OR: [{ email: email.toLowerCase() }, { username }] },
  });
  if (existing) {
    console.log(`  admin: ${existing.email} already exists`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      username,
      passwordHash: await hashPassword(password),
      roleId: role.id,
      emailVerifiedAt: new Date(),
      serverLimit: 1000,
      backupLimit: 1000,
      databaseLimit: 1000,
      allocationLimit: 1000,
    },
  });
  console.log(`  admin: created ${user.email}`);
}

async function main(): Promise<void> {
  console.log('Seeding Storm Panel database...');
  const permissionIds = await seedPermissions();
  await seedRoles(permissionIds);
  await seedTemplates();
  await seedBackupStorage();
  await seedSettings();
  await seedAdmin();
  console.log('Seed complete.');
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
