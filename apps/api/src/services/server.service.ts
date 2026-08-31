import type { FastifyInstance } from 'fastify';
import type { Node, Prisma, Server, ServerAllocation } from '@storm/database';
import { generatePassword, generateReadableId } from '@storm/security';
import {
  ErrorCode,
  ServerStatus,
  WebhookEvent,
  type AgentConfigFile,
  type AgentServerSpec,
  type ConfigFileParser,
  type CreateServerInput,
  type PowerAction,
} from '@storm/types';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors.js';
import { SERVER_INCLUDE } from './server-access.service.js';

/**
 * What this reads off a template variable — a structural subset, so both a
 * Prisma row and the trimmed shape the routes hand over satisfy it.
 */
interface TemplateVariableRow {
  envVariable: string;
  defaultValue: string;
  rules: string;
  userEditable: boolean;
}

const RESERVED_ENV = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'HOME',
  'HOSTNAME',
  'USER',
  'SHELL',
  'DOCKER_HOST',
  'STORM_TOKEN',
]);

export interface ServerWithRelations extends Server {
  node: Node;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape
  template: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape
  allocations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma include shape
  variables: any[];
}

export class ServerService {
  constructor(private readonly app: FastifyInstance) {}

  private get prisma() {
    return this.app.prisma;
  }

  /* -------------------------------------------------------- creation -- */

  /**
   * Creates a server row, claims its allocations and queues installation.
   *
   * Everything up to the agent call happens inside one transaction so a failure
   * cannot leave an allocation claimed by a server that does not exist.
   */
  async create(
    input: CreateServerInput,
    ownerId: string,
    actorId: string,
  ): Promise<ServerWithRelations> {
    const [owner, node, template] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: ownerId } }),
      this.prisma.node.findUnique({ where: { id: input.nodeId } }),
      this.prisma.gameTemplate.findUnique({
        where: { id: input.templateId },
        include: { variables: true },
      }),
    ]);

    if (!owner) throw notFound('Owner was not found', ErrorCode.USER_NOT_FOUND);
    if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);
    if (!template || !template.isActive) {
      throw notFound('Game template was not found', ErrorCode.TEMPLATE_NOT_FOUND);
    }
    if (node.maintenanceMode) {
      throw conflict('That node is in maintenance mode and cannot accept new servers');
    }

    await this.assertOwnerWithinLimits(ownerId, input);
    await this.assertNodeHasCapacity(node, input.limits.memoryLimit, input.limits.diskLimit);

    const dockerImage = input.dockerImage ?? template.defaultImage;
    const images = (template.dockerImages ?? {}) as Record<string, string>;
    if (!Object.values(images).includes(dockerImage)) {
      throw unprocessable('That docker image is not offered by the selected template');
    }

    const environment = this.buildEnvironment(template.variables, input.environment, true);
    const shortId = await this.uniqueShortId();
    const sftpUsername = `${slugForSftp(input.name)}.${shortId.toLowerCase()}`;
    const sftpPassword = generatePassword(28);

    const server = await this.prisma.$transaction(async (tx) => {
      const created = await tx.server.create({
        data: {
          name: input.name,
          description: input.description ?? null,
          shortId,
          ownerId,
          nodeId: node.id,
          templateId: template.id,
          status: input.skipInstall ? ServerStatus.OFFLINE : ServerStatus.INSTALLING,
          dockerImage,
          startupCommand: input.startupCommand ?? template.startupCommand,
          cpuLimit: input.limits.cpuLimit,
          memoryLimit: input.limits.memoryLimit,
          diskLimit: input.limits.diskLimit,
          swapLimit: input.limits.swapLimit,
          ioWeight: input.limits.ioWeight,
          pidsLimit: input.limits.pidsLimit,
          oomKill: input.limits.oomKill,
          sftpUsername,
          sftpPasswordEnc: this.app.encrypter.encrypt(sftpPassword),
          installedAt: input.skipInstall ? new Date() : null,
          variables: {
            create: template.variables.map((variable) => ({
              key: variable.envVariable,
              value: environment[variable.envVariable] ?? variable.defaultValue,
              templateVariableId: variable.id,
            })),
          },
        },
      });

      await this.claimAllocations(
        tx,
        node.id,
        created.id,
        input.allocationId,
        input.additionalAllocationIds,
      );

      return created;
    });

    const full = await this.findWithRelations(server.id);

    await this.app.audit.system({
      action: 'server.created',
      targetType: 'server',
      targetId: server.id,
      targetLabel: server.name,
      metadata: { nodeId: node.id, templateId: template.id, actorId },
    });
    await this.app.webhooks.dispatch(WebhookEvent.SERVER_CREATED, {
      serverId: server.id,
      uuid: server.uuid,
      name: server.name,
      nodeId: node.id,
      ownerId,
    });

    if (!input.skipInstall) {
      await this.app.queues.enqueueInstall(server.id, {
        startOnCompletion: input.startOnCompletion,
      });
    }

    return full;
  }

  private async uniqueShortId(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = generateReadableId(8);
      const existing = await this.prisma.server.findUnique({ where: { shortId: candidate } });
      if (!existing) return candidate;
    }
    throw new AppError(
      500,
      ErrorCode.INTERNAL_ERROR,
      'Could not allocate a unique server identifier',
    );
  }

  /**
   * Claims allocations for a new server. Runs inside the creation transaction
   * and re-checks `serverId IS NULL` in the update predicate, so two concurrent
   * creations cannot both take the same port.
   */
  private async claimAllocations(
    tx: Prisma.TransactionClient,
    nodeId: string,
    serverId: string,
    primaryId: string | undefined,
    additionalIds: string[],
  ): Promise<string[]> {
    let primary = primaryId;

    if (!primary) {
      const free = await tx.serverAllocation.findFirst({
        where: { nodeId, serverId: null },
        orderBy: { port: 'asc' },
      });
      if (!free) {
        throw new AppError(
          409,
          ErrorCode.NO_ALLOCATION_AVAILABLE,
          'That node has no free ports. Add allocations before creating a server.',
        );
      }
      primary = free.id;
    }

    const ids = [primary, ...additionalIds.filter((id) => id !== primary)];

    // `serverId: null` in the predicate makes the claim atomic: a competing
    // transaction blocks on the row lock and then matches zero rows, so the
    // whole creation is rolled back rather than double-booking a port.
    const claimed = await tx.serverAllocation.updateMany({
      where: { id: { in: ids }, nodeId, serverId: null },
      data: { serverId },
    });
    if (claimed.count !== ids.length) {
      throw new AppError(
        409,
        ErrorCode.NO_ALLOCATION_AVAILABLE,
        'One or more of those ports were taken by another server. Choose different ports.',
      );
    }

    await tx.serverAllocation.update({ where: { id: primary }, data: { isPrimary: true } });
    return ids;
  }

  private async assertOwnerWithinLimits(ownerId: string, input: CreateServerInput): Promise<void> {
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
    const existing = await this.prisma.server.aggregate({
      where: { ownerId },
      _count: { _all: true },
      _sum: { memoryLimit: true, diskLimit: true, cpuLimit: true },
    });

    if (owner.serverLimit > 0 && existing._count._all >= owner.serverLimit) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This account may own at most ${owner.serverLimit} servers`,
      );
    }
    if (
      owner.memoryLimit > 0 &&
      (existing._sum.memoryLimit ?? 0) + input.limits.memoryLimit > owner.memoryLimit
    ) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This account may allocate at most ${owner.memoryLimit} MiB of memory`,
      );
    }
    if (
      owner.diskLimit > 0 &&
      (existing._sum.diskLimit ?? 0) + input.limits.diskLimit > owner.diskLimit
    ) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This account may allocate at most ${owner.diskLimit} MiB of disk`,
      );
    }
    if (
      owner.cpuLimit > 0 &&
      (existing._sum.cpuLimit ?? 0) + input.limits.cpuLimit > owner.cpuLimit
    ) {
      throw new AppError(
        409,
        ErrorCode.RESOURCE_LIMIT_REACHED,
        `This account may allocate at most ${owner.cpuLimit}% CPU`,
      );
    }
  }

  /** Overcommit-aware capacity check for the target node. */
  async assertNodeHasCapacity(
    node: Node,
    memoryMb: number,
    diskMb: number,
    excludeServerId?: string,
  ): Promise<void> {
    const allocated = await this.prisma.server.aggregate({
      where: { nodeId: node.id, ...(excludeServerId ? { NOT: { id: excludeServerId } } : {}) },
      _sum: { memoryLimit: true, diskLimit: true },
    });

    const memoryCeiling = Math.floor(node.memoryTotal * (1 + node.memoryOvercommit / 100));
    const diskCeiling = Math.floor(node.diskTotal * (1 + node.diskOvercommit / 100));

    if ((allocated._sum.memoryLimit ?? 0) + memoryMb > memoryCeiling) {
      throw new AppError(
        409,
        ErrorCode.INSUFFICIENT_NODE_CAPACITY,
        `Node "${node.name}" does not have ${memoryMb} MiB of memory available`,
      );
    }
    if ((allocated._sum.diskLimit ?? 0) + diskMb > diskCeiling) {
      throw new AppError(
        409,
        ErrorCode.INSUFFICIENT_NODE_CAPACITY,
        `Node "${node.name}" does not have ${diskMb} MiB of disk available`,
      );
    }
  }

  /**
   * Refuses an operation that would grow a server already at its disk limit.
   *
   * Nothing else enforces this. `diskLimit` reaches the node agent, which
   * validates it and drops it: Docker's own quota (`StorageOpt`) needs an
   * xfs or btrfs backing filesystem with project quotas turned on, so it
   * cannot be set unconditionally, and the agent has no other ceiling. So the
   * panel enforces the paths it controls — uploads, writes, copies, archive
   * extraction, restores and starting the server — and a customer who was
   * sold 10 GiB can no longer quietly fill the node through the file manager.
   *
   * What this does not do: stop the game itself writing inside the container.
   * That needs a filesystem quota on the host, which is a deployment
   * decision rather than a setting — DEPLOYMENT.md says how.
   *
   * Usage comes from the last stats sample rather than a fresh measurement:
   * walking a multi-gigabyte directory on every upload would cost more than
   * the overshoot it prevents. So this stops sustained overuse, not the
   * instant of crossing the line.
   */
  async assertDiskWithinLimit(server: { id: string; diskLimit: number }): Promise<void> {
    if (server.diskLimit <= 0) return; // 0 means unlimited, as everywhere else.

    const latest = await this.prisma.serverStat.findFirst({
      where: { serverId: server.id },
      orderBy: { createdAt: 'desc' },
      select: { diskBytes: true },
    });
    // No sample yet — a server that has never reported cannot be shown to be
    // over, and refusing here would block the first upload to a new server.
    if (!latest) return;

    const usedMb = Math.floor(Number(latest.diskBytes) / (1024 * 1024));
    if (usedMb < server.diskLimit) return;

    throw new AppError(
      409,
      ErrorCode.RESOURCE_LIMIT_REACHED,
      `This server is using ${usedMb} MiB of its ${server.diskLimit} MiB of disk. ` +
        'Delete some files, or ask an administrator for more space.',
    );
  }

  /* ----------------------------------------------------- environment -- */

  /**
   * Merges template defaults with submitted values.
   *
   * Non-editable variables can only be set at creation time (`allowLocked`);
   * customers editing a server never get to change them, and reserved process
   * variables like PATH or LD_PRELOAD are rejected outright.
   */
  buildEnvironment(
    templateVariables: TemplateVariableRow[],
    submitted: Record<string, string>,
    allowLocked: boolean,
  ): Record<string, string> {
    const environment: Record<string, string> = {};
    const errors: Record<string, string[]> = {};

    for (const variable of templateVariables) {
      const provided = submitted[variable.envVariable];
      const editable = variable.userEditable || allowLocked;
      const value = provided !== undefined && editable ? provided : variable.defaultValue;

      const problem = validateAgainstRules(value, variable.rules);
      if (problem) {
        (errors[variable.envVariable] ??= []).push(problem);
        continue;
      }
      environment[variable.envVariable] = value;
    }

    for (const key of Object.keys(submitted)) {
      if (RESERVED_ENV.has(key)) {
        (errors[key] ??= []).push('This variable name is reserved and cannot be set');
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Some server variables are invalid', {
        details: errors,
      });
    }
    return environment;
  }

  /* ---------------------------------------------------------- agents -- */

  /** Builds the container specification handed to the node agent. */
  /**
   * Builds the specification a node needs to run this server.
   *
   * `allocationOverride` exists for a move: while one is running the server
   * holds ports on both nodes at once, and reading them from the row would let
   * the old node's address win — baked into SERVER_IP, the startup command and
   * every config file the template writes. The caller that knows which node
   * the spec is for passes that node's ports instead.
   */
  async buildAgentSpec(
    serverId: string,
    allocationOverride?: ServerAllocation[],
  ): Promise<AgentServerSpec> {
    const server = await this.findWithRelations(serverId);
    const variables = Object.fromEntries(server.variables.map((v) => [v.key, v.value]));
    const allocations = allocationOverride ?? server.allocations;
    const primary = allocations.find((a) => a.isPrimary) ?? allocations[0];

    const context: Record<string, string> = {
      ...variables,
      SERVER_MEMORY: String(server.memoryLimit),
      SERVER_IP: primary?.ip ?? '0.0.0.0',
      SERVER_PORT: String(primary?.port ?? 0),
      SERVER_UUID: server.uuid,
      SERVER_NAME_RAW: server.name,
      STORM_SERVER_ID: server.shortId,
    };

    return {
      uuid: server.uuid,
      name: server.name,
      image: server.dockerImage,
      startupCommand: renderTemplate(server.startupCommand, context),
      stopCommand: server.template?.stopCommand ?? '^C',
      environment: context,
      limits: {
        cpuPercent: server.cpuLimit,
        memoryMb: server.memoryLimit,
        swapMb: server.swapLimit,
        diskMb: server.diskLimit,
        ioWeight: server.ioWeight,
        pidsLimit: server.pidsLimit,
        oomKill: server.oomKill,
      },
      ports: allocations.map((allocation) => ({
        ip: allocation.ip,
        port: allocation.port,
        containerPort: allocation.port,
        protocol: allocation.protocol === 'UDP' ? ('udp' as const) : ('tcp' as const),
      })),
      mounts: [],
      startupDetection: server.template?.startupDetection || undefined,
      crashDetection: server.template?.crashDetection || undefined,
      configFiles: buildConfigFiles(server.template?.configFiles, {
        'server.allocation.ip': primary?.ip ?? '0.0.0.0',
        'server.allocation.port': String(primary?.port ?? 0),
        'server.build.memory': String(server.memoryLimit),
        'server.build.disk': String(server.diskLimit),
        'server.build.cpu': String(server.cpuLimit),
        'server.uuid': server.uuid,
        'server.name': server.name,
        ...Object.fromEntries(Object.entries(context).map(([key, value]) => [`env.${key}`, value])),
      }),
      labels: {
        'storm.server.uuid': server.uuid,
        'storm.server.id': server.shortId,
        'storm.owner.id': server.ownerId,
        'storm.managed': 'true',
      },
    };
  }

  async findWithRelations(serverId: string): Promise<ServerWithRelations> {
    const server = await this.prisma.server.findUnique({
      where: { id: serverId },
      include: SERVER_INCLUDE,
    });
    if (!server) throw notFound('Server was not found', ErrorCode.SERVER_NOT_FOUND);
    return server as unknown as ServerWithRelations;
  }

  /* ----------------------------------------------------------- power -- */

  async sendPower(serverId: string, action: PowerAction): Promise<void> {
    const server = await this.findWithRelations(serverId);

    if (server.suspendedAt && action !== 'stop' && action !== 'kill') {
      throw new AppError(403, ErrorCode.SERVER_SUSPENDED, 'This server is suspended');
    }
    if (!server.installedAt) {
      throw new AppError(409, ErrorCode.SERVER_NOT_INSTALLED, 'This server is still installing');
    }

    await this.app.agents.request(server.node, `/api/v1/servers/${server.uuid}/power`, {
      method: 'POST',
      body: { action },
    });

    const optimistic =
      action === 'start' || action === 'restart'
        ? ServerStatus.STARTING
        : action === 'kill'
          ? ServerStatus.OFFLINE
          : ServerStatus.STOPPING;

    await this.updateStatus(server.id, optimistic);
  }

  async updateStatus(serverId: string, status: ServerStatus): Promise<void> {
    const server = await this.prisma.server.update({
      where: { id: serverId },
      data: {
        status,
        ...(status === ServerStatus.CRASHED ? { crashedAt: new Date() } : {}),
        ...(status === ServerStatus.STARTING ? { lastStartAt: new Date() } : {}),
      },
    });
    await this.app.notifications.broadcastServerStatus(server.id, server.ownerId, status);
  }

  /** Pushes the current specification to the node and (re)creates the container. */
  async syncToNode(serverId: string): Promise<void> {
    const server = await this.findWithRelations(serverId);
    const spec = await this.buildAgentSpec(serverId);
    await this.app.agents.request(server.node, `/api/v1/servers`, { method: 'PUT', body: spec });
  }
}

const CONFIG_PARSERS = new Set<ConfigFileParser>(['properties', 'ini', 'json', 'yaml']);

/**
 * Turns a template's `configFiles` map into the flat, fully-resolved form the
 * agent applies. Placeholders are resolved here because the panel is the only
 * side that knows the server's allocation and limits — the agent receives
 * literal values and never has to be told about servers.
 *
 * A malformed entry is dropped rather than thrown: an operator's typo in one
 * template should not make every server on it unstartable.
 */
export function buildConfigFiles(raw: unknown, context: Record<string, string>): AgentConfigFile[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];

  const files: AgentConfigFile[] = [];

  for (const [path, definition] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof definition !== 'object' || definition === null) continue;

    const { parser, find } = definition as { parser?: unknown; find?: unknown };
    if (typeof parser !== 'string' || !CONFIG_PARSERS.has(parser as ConfigFileParser)) continue;
    if (typeof find !== 'object' || find === null || Array.isArray(find)) continue;

    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(find as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      resolved[key] = renderTemplate(value, context);
    }

    if (Object.keys(resolved).length > 0) {
      files.push({ path, parser: parser as ConfigFileParser, find: resolved });
    }
  }

  return files;
}

/** Replaces `{{VAR}}` placeholders in startup commands. */
export function renderTemplate(input: string, context: Record<string, string>): string {
  return input.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (match, key: string) => {
    const normalised = key.replace(/^server\./i, '').toUpperCase();
    return context[key] ?? context[normalised] ?? match;
  });
}

/**
 * Laravel-style rule strings from the template variables
 * (`required|string|max:64|in:a,b|regex:^x$`).
 */
export function validateAgainstRules(value: string, rules: string): string | null {
  const parts = rules
    .split('|')
    .map((rule) => rule.trim())
    .filter(Boolean);
  const required = parts.includes('required');

  if (!required && value === '') return null;
  if (required && value === '') return 'This value is required';

  for (const rule of parts) {
    const [name, argument = ''] = rule.split(':', 2) as [string, string?];
    switch (name) {
      case 'integer':
        if (!/^-?\d+$/.test(value)) return 'Must be a whole number';
        break;
      case 'numeric':
        if (Number.isNaN(Number(value))) return 'Must be a number';
        break;
      case 'boolean':
        if (!['true', 'false', '0', '1'].includes(value.toLowerCase()))
          return 'Must be true or false';
        break;
      case 'max':
        if (value.length > Number(argument)) return `Must be at most ${argument} characters`;
        break;
      case 'min':
        if (value.length < Number(argument)) return `Must be at least ${argument} characters`;
        break;
      case 'between': {
        const [low, high] = argument.split(',').map(Number);
        const numeric = Number(value);
        if (Number.isNaN(numeric) || numeric < (low ?? 0) || numeric > (high ?? 0)) {
          return `Must be between ${low} and ${high}`;
        }
        break;
      }
      case 'in':
        if (!argument.split(',').includes(value)) return `Must be one of: ${argument}`;
        break;
      case 'regex':
        try {
          if (!new RegExp(argument).test(value)) return 'Value has an invalid format';
        } catch {
          return null; // A broken rule must not block the customer.
        }
        break;
      case 'alpha_dash':
        if (!/^[A-Za-z0-9_-]+$/.test(value)) {
          return 'Only letters, numbers, dashes and underscores are allowed';
        }
        break;
      case 'url': {
        // Constrained to http(s): a template variable holding a URL is usually
        // fetched by an install script, and `file:` or `gopher:` there is not
        // something anyone asked for.
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          return 'Must be a valid URL';
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return 'Must be an http or https URL';
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

function slugForSftp(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16);
  return slug.length >= 3 ? slug : 'storm';
}

declare module 'fastify' {
  interface FastifyInstance {
    servers: ServerService;
  }
}
