import Docker from 'dockerode';
import { readFileSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import {
  ServerStatus,
  type AgentServerSpec,
  type AgentServerStats,
  type PowerAction,
} from '@storm/types';
import { AgentError, notFound } from '../lib/errors.js';

export interface DockerServiceOptions {
  socketPath: string;
  network: string;
  dataDirectory: string;
  logger: Logger;
}

interface ContainerStatsSample {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimit: number;
  networkRx: number;
  networkTx: number;
}

const CONTAINER_PREFIX = 'storm-';
const DESIRED_NOFILE = 65535;

/**
 * Highest file-descriptor limit this host will actually grant a container.
 *
 * Asking for more than the daemon's own hard limit makes `docker start` fail
 * outright with an rlimit error, which is a common trap on nested or
 * constrained hosts, so the request is clamped to what is achievable.
 */
function resolveNofileLimit(): number | null {
  try {
    const limits = readFileSync('/proc/self/limits', 'utf8');
    const row = limits.split('\n').find((line) => line.startsWith('Max open files'));
    const hard = row?.trim().split(/\s{2,}/)[2];
    if (!hard) return null;
    if (hard === 'unlimited') return DESIRED_NOFILE;

    const parsed = Number(hard);
    return Number.isFinite(parsed) ? Math.min(DESIRED_NOFILE, parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Owns every Docker interaction for the agent.
 *
 * Containers are created with a fixed security posture: no new privileges, all
 * capabilities dropped except the handful a game server needs, a bind mount of
 * nothing outside the server's own directory, and a non-root user. A customer
 * with full console access still cannot reach the host.
 */
export class DockerService {
  private readonly docker: Docker;
  private readonly log: Logger;
  private readonly nofileLimit: number | null;

  constructor(private readonly options: DockerServiceOptions) {
    this.docker = new Docker({ socketPath: options.socketPath });
    this.log = options.logger.child({ component: 'docker' });
    this.nofileLimit = resolveNofileLimit();
  }

  containerName(uuid: string): string {
    return `${CONTAINER_PREFIX}${uuid}`;
  }

  async ping(): Promise<void> {
    await this.docker.ping();
  }

  async version(): Promise<string> {
    const info = (await this.docker.version()) as { Version?: string };
    return info.Version ?? 'unknown';
  }

  async listManaged(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: ['storm.managed=true'] },
    });
  }

  async containerCounts(): Promise<{ total: number; running: number }> {
    const all = await this.docker.listContainers({ all: true });
    return { total: all.length, running: all.filter((c) => c.State === 'running').length };
  }

  private container(uuid: string): Docker.Container {
    return this.docker.getContainer(this.containerName(uuid));
  }

  async inspect(uuid: string): Promise<Docker.ContainerInspectInfo | null> {
    try {
      return await this.container(uuid).inspect();
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async status(uuid: string): Promise<ServerStatus> {
    return (await this.statusWithReason(uuid)).status;
  }

  /**
   * The status and, when it crashed, why.
   *
   * Docker distinguishes "the process failed" from "the kernel killed it for
   * exceeding its memory limit", and the second is by far the most common way
   * a game server dies. Collapsing both into CRASHED left the panel saying
   * "stopped unexpectedly" and the console showing a bare "Killed" — true, and
   * of no use to someone who needs to be told to raise the memory.
   */
  async statusWithReason(
    uuid: string,
  ): Promise<{ status: ServerStatus; oomKilled: boolean; exitCode: number | null }> {
    const info = await this.inspect(uuid);
    if (!info) return { status: ServerStatus.OFFLINE, oomKilled: false, exitCode: null };

    const state = info.State;
    if (state.Restarting) {
      return { status: ServerStatus.STARTING, oomKilled: false, exitCode: null };
    }
    if (state.Running) return { status: ServerStatus.ONLINE, oomKilled: false, exitCode: null };

    const exited = state.ExitCode !== 0 && state.FinishedAt !== '0001-01-01T00:00:00Z';
    if (state.OOMKilled || exited) {
      return {
        status: ServerStatus.CRASHED,
        // Exit 137 is SIGKILL, which is what the kernel's OOM killer sends.
        // Docker does not always set OOMKilled on cgroup v2, so take either.
        oomKilled: Boolean(state.OOMKilled) || state.ExitCode === 137,
        exitCode: state.ExitCode ?? null,
      };
    }
    return { status: ServerStatus.OFFLINE, oomKilled: false, exitCode: state.ExitCode ?? null };
  }

  /* ------------------------------------------------------------ images -- */

  async ensureImage(image: string, onProgress?: (line: string) => void): Promise<void> {
    const exists = await this.docker
      .getImage(image)
      .inspect()
      .then(() => true)
      .catch(() => false);
    if (exists) return;

    this.log.info({ image }, 'pulling image');
    const stream = await this.docker.pull(image);

    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (error: Error | null) => (error ? reject(error) : resolve()),
        (event: { status?: string; progress?: string }) => {
          if (onProgress && event.status) {
            onProgress(`${event.status}${event.progress ? ` ${event.progress}` : ''}`);
          }
        },
      );
    });
  }

  async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks({ filters: { name: [this.options.network] } });
    if (networks.some((network) => network.Name === this.options.network)) return;

    await this.docker.createNetwork({
      Name: this.options.network,
      Driver: 'bridge',
      // Isolating the bridge stops one customer's container from reaching
      // another's over the shared network.
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    });
    this.log.info({ network: this.options.network }, 'created docker network');
  }

  /* -------------------------------------------------------- containers -- */

  /** Creates or recreates the container for a server from its specification. */
  async createContainer(spec: AgentServerSpec): Promise<string> {
    const root = path.join(this.options.dataDirectory, spec.uuid);
    await fs.mkdir(root, { recursive: true, mode: 0o755 });

    await this.ensureNetwork();
    await this.ensureImage(spec.image);
    await this.removeContainer(spec.uuid, true).catch(() => undefined);

    const portBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
    const exposedPorts: Record<string, Record<string, never>> = {};
    for (const port of spec.ports) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposedPorts[key] = {};
      (portBindings[key] ??= []).push({ HostIp: port.ip, HostPort: String(port.port) });
    }

    const environment = Object.entries(spec.environment).map(([key, value]) => `${key}=${value}`);
    environment.push(
      `STARTUP=${spec.startupCommand}`,
      'TERM=xterm-256color',
      'HOME=/home/container',
    );

    const memoryBytes = spec.limits.memoryMb * 1024 * 1024;
    // Docker wants swap expressed as memory+swap; -1 means unlimited.
    const memorySwap = spec.limits.swapMb < 0 ? -1 : memoryBytes + spec.limits.swapMb * 1024 * 1024;

    const container = await this.docker.createContainer({
      name: this.containerName(spec.uuid),
      Image: spec.image,
      Hostname: spec.uuid.slice(0, 12),
      // Numeric uid rather than a name: base images vary and most have no
      // `container` user, but 1000:1000 always resolves.
      User: '1000:1000',
      WorkingDir: '/home/container',
      Env: environment,
      // The startup command is executed by a shell inside the container; the
      // panel has already substituted its variables.
      Entrypoint: ['/bin/sh', '-c'],
      Cmd: [spec.startupCommand],
      OpenStdin: true,
      Tty: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: exposedPorts,
      Labels: { ...spec.labels, 'storm.managed': 'true' },
      HostConfig: {
        Binds: [`${root}:/home/container:rw`],
        PortBindings: portBindings,
        NetworkMode: this.options.network,
        Memory: memoryBytes,
        MemoryReservation: Math.floor(memoryBytes * 0.75),
        MemorySwap: memorySwap,
        OomKillDisable: !spec.limits.oomKill,
        CpuQuota: spec.limits.cpuPercent > 0 ? spec.limits.cpuPercent * 1000 : 0,
        CpuPeriod: spec.limits.cpuPercent > 0 ? 100_000 : 0,
        BlkioWeight: spec.limits.ioWeight,
        PidsLimit: spec.limits.pidsLimit,
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        // Hardening: no privilege escalation, minimal capabilities, no host
        // devices, and a bounded log so a chatty server cannot fill the disk.
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'NET_BIND_SERVICE'],
        ReadonlyRootfs: false,
        Privileged: false,
        Tmpfs: { '/tmp': 'rw,exec,nosuid,size=256m' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '16m', 'max-file': '3' } },
        ...(this.nofileLimit
          ? { Ulimits: [{ Name: 'nofile', Soft: this.nofileLimit, Hard: this.nofileLimit }] }
          : {}),
      },
    });

    this.log.info({ uuid: spec.uuid, image: spec.image }, 'container created');
    return container.id;
  }

  async removeContainer(uuid: string, force = false): Promise<void> {
    const container = this.container(uuid);
    try {
      await container.remove({ force, v: true });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return;
      throw error;
    }
  }

  async power(uuid: string, action: PowerAction, stopCommand: string): Promise<void> {
    const container = this.container(uuid);
    const info = await this.inspect(uuid);
    if (!info) throw notFound('That server has no container on this node', 'SERVER_NOT_FOUND');

    switch (action) {
      case 'start':
        if (info.State.Running) return;
        await container.start();
        return;

      case 'stop':
        if (!info.State.Running) return;
        await this.gracefulStop(uuid, stopCommand);
        return;

      case 'restart':
        if (info.State.Running) await this.gracefulStop(uuid, stopCommand);
        await container.start();
        return;

      case 'kill':
        if (!info.State.Running) return;
        await container.kill().catch((error: unknown) => {
          if ((error as { statusCode?: number }).statusCode !== 409) throw error;
        });
        return;

      default:
        throw new AgentError(400, 'VALIDATION_ERROR', `Unknown power action: ${String(action)}`);
    }
  }

  /**
   * Sends the game's own stop command (e.g. `stop` for Minecraft) and waits for
   * a clean exit before falling back to SIGTERM/SIGKILL, so worlds are saved.
   */
  private async gracefulStop(uuid: string, stopCommand: string): Promise<void> {
    const container = this.container(uuid);

    if (stopCommand && stopCommand !== '^C') {
      await this.sendCommand(uuid, stopCommand).catch(() => undefined);
      const exited = await this.waitForExit(uuid, 30_000);
      if (exited) return;
    }

    await container.stop({ t: 30 }).catch((error: unknown) => {
      const status = (error as { statusCode?: number }).statusCode;
      // 304 = already stopped, 404 = already gone; both are the desired state.
      if (status === 304 || status === 404) return;
      throw error;
    });
  }

  private async waitForExit(uuid: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.inspect(uuid);
      if (!info || !info.State.Running) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  /* --------------------------------------------------- console + logs -- */

  /** Attaches to the container's TTY, returning a duplex stream. */
  async attach(uuid: string): Promise<Duplex> {
    const container = this.container(uuid);
    return (await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    })) as unknown as Duplex;
  }

  async sendCommand(uuid: string, command: string): Promise<void> {
    const info = await this.inspect(uuid);
    if (!info?.State.Running) {
      throw new AgentError(409, 'SERVER_BUSY', 'The server is not running');
    }

    const stream = await this.attach(uuid);
    // A TTY-attached process reads stdin exactly as a terminal would, so the
    // trailing newline is what actually submits the command.
    stream.write(`${command}\n`);
    stream.end();
  }

  async logs(uuid: string, tail = 200): Promise<string[]> {
    const info = await this.inspect(uuid);
    if (!info) return [];

    const buffer = (await this.container(uuid).logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    })) as unknown as Buffer;

    const text = info.Config.Tty ? buffer.toString('utf8') : demultiplex(buffer);
    return text.split(/\r?\n/).filter((line) => line.length > 0);
  }

  /* -------------------------------------------------------------- stats -- */

  async stats(uuid: string): Promise<AgentServerStats | null> {
    const info = await this.inspect(uuid);
    if (!info) return null;

    if (!info.State.Running) {
      return {
        uuid,
        status: await this.status(uuid),
        cpuPercent: 0,
        memoryBytes: 0,
        memoryLimit: info.HostConfig?.Memory ?? 0,
        diskBytes: 0,
        networkRx: 0,
        networkTx: 0,
        uptime: 0,
        timestamp: new Date().toISOString(),
      };
    }

    const raw = (await this.container(uuid).stats({
      stream: false,
    })) as unknown as Docker.ContainerStats;
    const sample = this.readStats(raw);
    const startedAt = new Date(info.State.StartedAt).getTime();

    return {
      uuid,
      status: ServerStatus.ONLINE,
      cpuPercent: sample.cpuPercent,
      memoryBytes: sample.memoryBytes,
      memoryLimit: sample.memoryLimit,
      diskBytes: 0,
      networkRx: sample.networkRx,
      networkTx: sample.networkTx,
      uptime: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0,
      timestamp: new Date().toISOString(),
    };
  }

  /** Streams stats for a running container until the returned stop() is called. */
  async streamStats(
    uuid: string,
    onSample: (stats: AgentServerStats) => void,
  ): Promise<() => void> {
    const container = this.container(uuid);
    const stream = (await container.stats({ stream: true })) as unknown as NodeJS.ReadableStream;
    let buffer = '';

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // The Docker stats stream emits newline-delimited JSON documents.
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;

        try {
          const raw = JSON.parse(line) as Docker.ContainerStats;
          const sample = this.readStats(raw);
          onSample({
            uuid,
            status: ServerStatus.ONLINE,
            cpuPercent: sample.cpuPercent,
            memoryBytes: sample.memoryBytes,
            memoryLimit: sample.memoryLimit,
            diskBytes: 0,
            networkRx: sample.networkRx,
            networkTx: sample.networkTx,
            uptime: 0,
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* partial frames are skipped */
        }
      }
    });

    stream.on('error', (error: Error) => {
      this.log.debug({ err: error, uuid }, 'stats stream error');
    });

    return () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    };
  }

  private readStats(raw: Docker.ContainerStats): ContainerStatsSample {
    const cpu = raw.cpu_stats;
    const preCpu = raw.precpu_stats;

    const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (preCpu?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (cpu?.system_cpu_usage ?? 0) - (preCpu?.system_cpu_usage ?? 0);
    const cores = cpu?.online_cpus ?? cpu?.cpu_usage?.percpu_usage?.length ?? 1;

    const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;

    // `cache` is page cache the kernel can reclaim; counting it makes every
    // container look permanently near its memory limit.
    const memoryStats = raw.memory_stats ?? {};
    const stats = memoryStats.stats as { inactive_file?: number; cache?: number } | undefined;
    const cache = stats?.inactive_file ?? stats?.cache ?? 0;
    const memoryBytes = Math.max(0, (memoryStats.usage ?? 0) - cache);

    let networkRx = 0;
    let networkTx = 0;
    for (const iface of Object.values(raw.networks ?? {})) {
      networkRx += (iface as { rx_bytes?: number }).rx_bytes ?? 0;
      networkTx += (iface as { tx_bytes?: number }).tx_bytes ?? 0;
    }

    return {
      cpuPercent: Number(cpuPercent.toFixed(2)),
      memoryBytes,
      memoryLimit: memoryStats.limit ?? 0,
      networkRx,
      networkTx,
    };
  }

  /* ------------------------------------------------------------ install -- */

  /**
   * Runs a template's install script in a disposable container that mounts the
   * server directory at /mnt/server. The game container is never used for
   * installation, so an install script cannot persist state into it.
   */
  async runInstall(
    uuid: string,
    options: {
      container: string;
      entrypoint: string;
      script: string;
      environment: Record<string, string>;
    },
    onOutput: (line: string) => void,
  ): Promise<void> {
    const root = path.join(this.options.dataDirectory, uuid);
    await fs.mkdir(root, { recursive: true, mode: 0o755 });

    const scriptDir = path.join(root, '.storm');
    await fs.mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'install.sh');
    await fs.writeFile(scriptPath, options.script, { mode: 0o755 });

    await this.ensureImage(options.container, onOutput);
    const name = `storm-install-${uuid}`;
    await this.docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined);

    const container = await this.docker.createContainer({
      name,
      Image: options.container,
      Entrypoint: [options.entrypoint],
      Cmd: ['/mnt/install/install.sh'],
      Env: Object.entries(options.environment).map(([key, value]) => `${key}=${value}`),
      WorkingDir: '/mnt/server',
      Tty: false,
      AttachStdout: true,
      AttachStderr: true,
      Labels: { 'storm.managed': 'true', 'storm.install': 'true', 'storm.server.uuid': uuid },
      HostConfig: {
        Binds: [`${root}:/mnt/server:rw`, `${scriptDir}:/mnt/install:ro`],
        Memory: 2048 * 1024 * 1024,
        NetworkMode: 'bridge',
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE', 'FOWNER'],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '32m', 'max-file': '2' } },
      },
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) onOutput(line);
      }
    };
    stdout.on('data', forward);
    stderr.on('data', forward);

    await container.start();
    const result = (await container.wait()) as { StatusCode: number };

    const logs = await container
      .logs({ stdout: true, stderr: true, tail: 50 })
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => '');

    await container.remove({ force: true }).catch(() => undefined);
    await fs.rm(scriptDir, { recursive: true, force: true }).catch(() => undefined);

    if (result.StatusCode !== 0) {
      onOutput(`[storm] Install failed with exit code ${result.StatusCode}`);
      throw new AgentError(
        500,
        'INSTALL_FAILED',
        `The install script exited with code ${result.StatusCode}. ${logs.slice(-400)}`,
      );
    }

    // The install container runs as root, so hand the files back to the
    // unprivileged uid the game container runs as.
    onOutput('[storm] Normalising file ownership...');
    await chownRecursive(root, 1000, 1000);
  }
}

/**
 * Docker multiplexes stdout and stderr for non-TTY containers: each frame is an
 * 8-byte header (stream id + big-endian length) followed by the payload.
 */
function demultiplex(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + length, buffer.length);
    parts.push(buffer.subarray(start, end).toString('utf8'));
    offset = end;
  }

  // Not a framed stream after all (older daemons, TTY mismatch) - fall back.
  return parts.length > 0 ? parts.join('') : buffer.toString('utf8');
}

/** Recursive chown that tolerates files a previous run already moved. */
async function chownRecursive(target: string, uid: number, gid: number): Promise<void> {
  await fs.chown(target, uid, gid).catch(() => undefined);
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await chownRecursive(child, uid, gid);
    } else {
      await fs.lchown(child, uid, gid).catch(() => undefined);
    }
  }
}
