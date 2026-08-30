#!/usr/bin/env node
/**
 * Storm Panel CLI.
 *
 * Runs against the same database and configuration as the API, so it works
 * whether or not the API process is up — which is exactly when you need it
 * (bootstrapping the first owner, recovering a locked-out admin, adding a node
 * before the panel has any).
 */
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApiEnv, STORM_VERSION } from '@storm/config';
import { createPrismaClient, type PrismaClient } from '@storm/database';
import {
  Encrypter,
  generatePassword,
  generateReadableId,
  generateToken,
  hashPassword,
  hashToken,
} from '@storm/security';
import { ROLE_PERMISSIONS, type RoleName } from '@storm/types';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PACKAGE = path.resolve(HERE, '../../../../packages/database');

/**
 * ANSI colours, built from the escape byte explicitly so the source stays
 * readable and no literal control characters end up in the file.
 */
const ESC = String.fromCharCode(27);
const colour = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
};

const log = {
  info: (message: string) => console.log(message),
  success: (message: string) => console.log(`${colour.green}✔${colour.reset} ${message}`),
  warn: (message: string) => console.log(`${colour.yellow}!${colour.reset} ${message}`),
  error: (message: string) => console.error(`${colour.red}✖${colour.reset} ${message}`),
  heading: (message: string) => console.log(`\n${colour.bold}${message}${colour.reset}`),
  field: (label: string, value: string) =>
    console.log(`  ${colour.dim}${label.padEnd(16)}${colour.reset}${value}`),
};

async function prompt(question: string, options: { mask?: boolean; fallback?: string } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    // Password prompts must not leave the secret in the terminal scrollback.
    if (options.mask) {
      const originalWrite = stdout.write.bind(stdout);
      let masking = false;
      (stdout as unknown as { write: typeof originalWrite }).write = ((chunk: string, ...rest: unknown[]) => {
        if (masking && typeof chunk === 'string' && !chunk.includes('\n')) {
          return originalWrite('*', ...(rest as []));
        }
        return originalWrite(chunk, ...(rest as []));
      }) as typeof originalWrite;

      const pending = rl.question(`${question}: `);
      masking = true;
      const answer = await pending;
      masking = false;
      (stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
      stdout.write('\n');
      return answer.trim() || options.fallback || '';
    }

    const suffix = options.fallback ? ` ${colour.dim}(${options.fallback})${colour.reset}` : '';
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || options.fallback || '';
  } finally {
    rl.close();
  }
}

function withPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const env = loadApiEnv();
  const prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  return fn(prisma).finally(() => void prisma.$disconnect());
}

const program = new Command();

program
  .name('storm')
  .description('Storm Panel command line interface')
  .version(STORM_VERSION);

/* --------------------------------------------------------------- install -- */

program
  .command('install')
  .description('Run migrations, seed reference data and create the first owner account')
  .option('--skip-migrate', 'assume migrations have already been applied')
  .action(async (options: { skipMigrate?: boolean }) => {
    log.heading('Storm Panel installation');

    const env = loadApiEnv();
    log.field('Database', env.DATABASE_URL.replace(/:\/\/[^@]+@/, '://***@'));
    log.field('Redis', env.REDIS_URL);

    if (!options.skipMigrate) {
      log.info('\nApplying database migrations...');
      try {
        await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
          cwd: DATABASE_PACKAGE,
          env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
        });
        log.success('Migrations applied');
      } catch (error) {
        log.error(`Migrations failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
    }

    log.info('Seeding roles, permissions and game templates...');
    try {
      await execFileAsync('npx', ['tsx', 'src/seed/index.ts'], {
        cwd: DATABASE_PACKAGE,
        env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      });
      log.success('Seed complete');
    } catch (error) {
      log.error(`Seed failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }

    const owners = await withPrisma((prisma) =>
      prisma.user.count({ where: { role: { name: 'OWNER' } } }),
    );

    if (owners === 0) {
      log.heading('Create the first owner account');
      await createUser({ role: 'OWNER' });
    } else {
      log.success(`${owners} owner account(s) already exist`);
    }

    log.heading('Storm Panel is ready.');
    log.field('Panel', env.APP_URL);
    log.field('API docs', `${env.APP_URL}/api/docs`);
  });

/* ------------------------------------------------------------- migration -- */

program
  .command('migrate')
  .description('Apply pending database migrations')
  .action(async () => {
    const env = loadApiEnv();
    try {
      const { stdout: output } = await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: DATABASE_PACKAGE,
        env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      });
      log.info(output.trim());
      log.success('Database is up to date');
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('seed')
  .description('Re-run the idempotent seed (roles, permissions, templates, settings)')
  .action(async () => {
    const env = loadApiEnv();
    try {
      const { stdout: output } = await execFileAsync('npx', ['tsx', 'src/seed/index.ts'], {
        cwd: DATABASE_PACKAGE,
        env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
      });
      log.info(output.trim());
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

/* ----------------------------------------------------------------- users -- */

interface CreateUserOptions {
  email?: string;
  username?: string;
  password?: string;
  role?: RoleName;
}

async function createUser(options: CreateUserOptions): Promise<void> {
  const email = options.email ?? (await prompt('Email address'));
  const username = options.username ?? (await prompt('Username', { fallback: email.split('@')[0] }));
  const password = options.password ?? (await prompt('Password (blank to generate)', { mask: true }));
  const role = options.role ?? 'ADMIN';

  if (!email.includes('@')) {
    log.error('That does not look like an email address');
    process.exitCode = 1;
    return;
  }

  const finalPassword = password || generatePassword(20);
  if (finalPassword.length < 10) {
    log.error('Password must be at least 10 characters');
    process.exitCode = 1;
    return;
  }

  await withPrisma(async (prisma) => {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: email.toLowerCase() }, { username }] },
    });
    if (existing) {
      log.error(`A user with that email or username already exists (${existing.email})`);
      process.exitCode = 1;
      return;
    }

    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) {
      log.error(`Role ${role} does not exist. Run "storm seed" first.`);
      process.exitCode = 1;
      return;
    }

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        username,
        passwordHash: await hashPassword(finalPassword),
        roleId: roleRow.id,
        emailVerifiedAt: new Date(),
        serverLimit: role === 'CUSTOMER' ? 2 : 1000,
        backupLimit: role === 'CUSTOMER' ? 5 : 1000,
        databaseLimit: role === 'CUSTOMER' ? 2 : 1000,
        allocationLimit: role === 'CUSTOMER' ? 5 : 1000,
      },
    });

    log.success(`Created ${role} account`);
    log.field('Email', user.email);
    log.field('Username', user.username);
    log.field('Permissions', String(ROLE_PERMISSIONS[role].length));
    if (!password) {
      log.field('Password', `${colour.yellow}${finalPassword}${colour.reset}`);
      log.warn('Store this password now — it is not recoverable.');
    }
  });
}

const admin = program.command('admin').description('Administrator account management');

admin
  .command('create')
  .description('Create an administrator account')
  .option('-e, --email <email>', 'email address')
  .option('-u, --username <username>', 'username')
  .option('-p, --password <password>', 'password (omit to generate one)')
  .option('-r, --role <role>', 'OWNER, ADMIN, STAFF, SUPPORT or CUSTOMER', 'ADMIN')
  .action(async (options: CreateUserOptions) => {
    const role = (options.role ?? 'ADMIN').toUpperCase() as RoleName;
    if (!(role in ROLE_PERMISSIONS)) {
      log.error(`Unknown role: ${role}`);
      process.exitCode = 1;
      return;
    }
    await createUser({ ...options, role });
  });

admin
  .command('password')
  .description('Reset a password by email')
  .argument('<email>', 'account email address')
  .action(async (email: string) => {
    await withPrisma(async (prisma) => {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user) {
        log.error('No account with that email address');
        process.exitCode = 1;
        return;
      }

      const password = generatePassword(20);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
      // Every existing session must die with the old password.
      await prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      log.success(`Password reset for ${user.email}`);
      log.field('Password', `${colour.yellow}${password}${colour.reset}`);
      log.warn('All existing sessions were signed out.');
    });
  });

admin
  .command('disable-2fa')
  .description('Remove two-factor authentication from a locked-out account')
  .argument('<email>', 'account email address')
  .action(async (email: string) => {
    await withPrisma(async (prisma) => {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!user) {
        log.error('No account with that email address');
        process.exitCode = 1;
        return;
      }
      await prisma.twoFactorAuth.deleteMany({ where: { userId: user.id } });
      log.success(`Two-factor authentication removed for ${user.email}`);
    });
  });

admin
  .command('list')
  .description('List accounts, newest first')
  .option('-r, --role <role>', 'filter by role')
  .option('-q, --search <term>', 'match an email or username')
  .action(async (options: { role?: string; search?: string }) => {
    await withPrisma(async (prisma) => {
      const role = options.role?.toUpperCase() as RoleName | undefined;
      if (role && !(role in ROLE_PERMISSIONS)) {
        log.error(`Unknown role: ${options.role}`);
        process.exitCode = 1;
        return;
      }

      const users = await prisma.user.findMany({
        where: {
          ...(role ? { role: { name: role } } : {}),
          ...(options.search
            ? {
                OR: [
                  { email: { contains: options.search, mode: 'insensitive' as const } },
                  { username: { contains: options.search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        include: { role: true, twoFactor: { select: { enabled: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      if (users.length === 0) {
        log.warn('No accounts match');
        return;
      }

      log.heading(`${users.length} account(s)`);
      for (const entry of users) {
        // The state that explains "why can this person not sign in".
        const tone = entry.suspendedAt ? colour.red : colour.green;
        const state = entry.suspendedAt ? 'suspended' : entry.emailVerifiedAt ? 'active' : 'unverified';
        console.log(
          `  ${tone}●${colour.reset} ${entry.email.padEnd(32)} ${entry.username.padEnd(20)} ` +
            `${entry.role.name.padEnd(9)} ${state.padEnd(11)} ` +
            `${entry.twoFactor?.enabled ? '2fa' : '   '}`,
        );
      }
    });
  });

/* ----------------------------------------------------------------- nodes -- */

const node = program.command('node').description('Node management');

node
  .command('create')
  .description('Register a node and print its agent configuration')
  .requiredOption('-n, --name <name>', 'node name')
  .requiredOption('-l, --location <location>', 'human readable location')
  .requiredOption('-H, --hostname <hostname>', 'hostname the panel connects to')
  .requiredOption('-i, --ip <ip>', 'IP address')
  .option('--scheme <scheme>', 'http or https', 'https')
  .option('--agent-port <port>', 'agent port', '8081')
  .option('--sftp-port <port>', 'SFTP port', '2022')
  .option('--cpu <cores>', 'CPU cores', '4')
  .option('--memory <mib>', 'memory in MiB', '16384')
  .option('--disk <mib>', 'disk in MiB', '204800')
  .action(async (options: Record<string, string>) => {
    const env = loadApiEnv();

    await withPrisma(async (prisma) => {
      const encrypter = new Encrypter(env.ENCRYPTION_KEY);

      const created = await prisma.node.create({
        data: {
          name: options.name!,
          location: options.location!,
          hostname: options.hostname!,
          ip: options.ip!,
          scheme: options.scheme ?? 'https',
          agentPort: Number(options.agentPort ?? 8081),
          sftpPort: Number(options.sftpPort ?? 2022),
          cpuCores: Number(options.cpu ?? 4),
          memoryTotal: Number(options.memory ?? 16384),
          diskTotal: Number(options.disk ?? 204800),
        },
      });

      const token = generateToken(32);
      const secret = generateToken(32);
      const tokenId = generateToken(8).slice(0, 16);

      await prisma.nodeToken.create({
        data: {
          nodeId: created.id,
          name: 'cli',
          tokenId,
          tokenHash: hashToken(token),
          secretEnc: encrypter.encrypt(secret),
        },
      });

      log.success(`Node "${created.name}" registered`);
      log.heading('Agent configuration — save as /etc/storm/agent.env on the node');
      console.log(
        [
          `NODE_UUID=${created.uuid}`,
          `PANEL_URL=${env.APP_URL}`,
          `AGENT_HOST=0.0.0.0`,
          `AGENT_PORT=${created.agentPort}`,
          `AGENT_TOKEN_ID=${tokenId}`,
          `AGENT_TOKEN=${token}`,
          `AGENT_SECRET=${secret}`,
          `DATA_DIRECTORY=${created.dataDirectory}`,
          `BACKUP_DIRECTORY=${created.backupDirectory}`,
          `SFTP_ENABLED=true`,
          `SFTP_PORT=${created.sftpPort}`,
          `DOCKER_NETWORK=storm_net`,
          `LOG_LEVEL=info`,
          '',
        ].join('\n'),
      );
    });
  });

node
  .command('token')
  .description('Issue a fresh token for an existing node')
  .argument('<name>', 'node name')
  .action(async (name: string) => {
    const env = loadApiEnv();

    await withPrisma(async (prisma) => {
      const found = await prisma.node.findUnique({ where: { name } });
      if (!found) {
        log.error(`No node named "${name}"`);
        process.exitCode = 1;
        return;
      }

      const encrypter = new Encrypter(env.ENCRYPTION_KEY);
      const token = generateToken(32);
      const secret = generateToken(32);
      const tokenId = generateToken(8).slice(0, 16);

      await prisma.nodeToken.create({
        data: {
          nodeId: found.id,
          name: 'cli-rotation',
          tokenId,
          tokenHash: hashToken(token),
          secretEnc: encrypter.encrypt(secret),
        },
      });

      log.success(`New token issued for ${found.name}`);
      log.field('AGENT_TOKEN_ID', tokenId);
      log.field('AGENT_TOKEN', token);
      log.field('AGENT_SECRET', secret);
      log.warn('Update the agent configuration and restart it to use these.');
    });
  });

node
  .command('list')
  .description('List registered nodes')
  .action(async () => {
    await withPrisma(async (prisma) => {
      const nodes = await prisma.node.findMany({
        include: { _count: { select: { servers: true, allocations: true } } },
        orderBy: { name: 'asc' },
      });

      if (nodes.length === 0) {
        log.warn('No nodes registered yet');
        return;
      }

      log.heading(`${nodes.length} node(s)`);
      for (const entry of nodes) {
        const tone =
          entry.status === 'ONLINE' ? colour.green : entry.status === 'OFFLINE' ? colour.red : colour.yellow;
        console.log(
          `  ${tone}●${colour.reset} ${entry.name.padEnd(22)} ${entry.location.padEnd(18)} ` +
            `${String(entry._count.servers).padStart(3)} servers  ` +
            `${String(entry._count.allocations).padStart(4)} ports  ${entry.hostname}`,
        );
      }
    });
  });

/* --------------------------------------------------------------- servers -- */

const server = program.command('server').description('Server management');

server
  .command('list')
  .description('List servers')
  .option('--node <name>', 'filter by node name')
  .action(async (options: { node?: string }) => {
    await withPrisma(async (prisma) => {
      const servers = await prisma.server.findMany({
        where: options.node ? { node: { name: options.node } } : {},
        include: { node: true, owner: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      if (servers.length === 0) {
        log.warn('No servers found');
        return;
      }

      log.heading(`${servers.length} server(s)`);
      for (const entry of servers) {
        const tone =
          entry.status === 'ONLINE'
            ? colour.green
            : entry.status === 'CRASHED' || entry.status === 'SUSPENDED'
              ? colour.red
              : colour.dim;
        console.log(
          `  ${tone}●${colour.reset} ${entry.shortId}  ${entry.name.padEnd(26)} ` +
            `${entry.status.padEnd(14)} ${entry.node.name.padEnd(16)} ${entry.owner.username}`,
        );
      }
    });
  });

server
  .command('suspend')
  .description('Suspend a server by its short ID')
  .argument('<shortId>')
  .action(async (shortId: string) => {
    await withPrisma(async (prisma) => {
      const found = await prisma.server.findUnique({ where: { shortId } });
      if (!found) {
        log.error('No server with that ID');
        process.exitCode = 1;
        return;
      }
      await prisma.server.update({
        where: { id: found.id },
        data: { suspendedAt: new Date(), status: 'SUSPENDED' },
      });
      log.success(`Suspended ${found.name}`);
      log.warn('The container is not stopped by this command; do that from the panel.');
    });
  });

server
  .command('unsuspend')
  .description('Restore a suspended server')
  .argument('<shortId>')
  .action(async (shortId: string) => {
    await withPrisma(async (prisma) => {
      const found = await prisma.server.findUnique({ where: { shortId } });
      if (!found) {
        log.error('No server with that ID');
        process.exitCode = 1;
        return;
      }
      await prisma.server.update({
        where: { id: found.id },
        data: { suspendedAt: null, status: 'OFFLINE' },
      });
      log.success(`Restored ${found.name}`);
    });
  });

/* ---------------------------------------------------------------- system -- */

program
  .command('doctor')
  .description('Check that the panel can reach everything it depends on')
  .action(async () => {
    log.heading('Storm Panel diagnostics');

    let env;
    try {
      env = loadApiEnv();
      log.success('Environment configuration is valid');
    } catch (error) {
      log.error(`Environment: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }

    try {
      await withPrisma(async (prisma) => {
        await prisma.$queryRaw`SELECT 1`;
        const [users, nodes, servers, templates] = await Promise.all([
          prisma.user.count(),
          prisma.node.count(),
          prisma.server.count(),
          prisma.gameTemplate.count(),
        ]);
        log.success('Database reachable');
        log.field('Users', String(users));
        log.field('Nodes', String(nodes));
        log.field('Servers', String(servers));
        log.field('Templates', String(templates));
      });
    } catch (error) {
      log.error(`Database: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }

    try {
      const { Redis } = await import('ioredis');
      const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect();
      await redis.ping();
      await redis.quit();
      log.success('Redis reachable');
    } catch (error) {
      log.error(`Redis: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }

    const owners = await withPrisma((prisma) =>
      prisma.user.count({ where: { role: { name: 'OWNER' } } }),
    ).catch(() => 0);
    if (owners === 0) {
      log.warn('No owner account exists — run "storm admin create --role OWNER"');
    }
  });

program
  .command('key:generate')
  .description('Generate strong values for the required secrets')
  .action(() => {
    log.heading('Generated secrets — copy into your .env');
    console.log(`JWT_SECRET=${generateToken(48)}`);
    console.log(`ENCRYPTION_KEY=${generateToken(48)}`);
    console.log(`COOKIE_SECRET=${generateToken(48)}`);
    console.log(`\n${colour.dim}Changing ENCRYPTION_KEY makes existing encrypted values unreadable.${colour.reset}`);
  });

program
  .command('id')
  .description('Generate a readable identifier (useful for scripting)')
  .action(() => console.log(generateReadableId(8)));

program.parseAsync(process.argv).catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
