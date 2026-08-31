import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { ServerStatus, type AgentConfigFile, type AgentServerStats } from '@storm/types';
import type { DockerService } from './docker.service.js';

export interface ConsoleEvents {
  line: (uuid: string, line: string, timestamp: string) => void;
  /** `reason` distinguishes an out-of-memory kill from any other crash. */
  status: (uuid: string, status: ServerStatus, reason?: 'oom') => void;
  stats: (uuid: string, stats: AgentServerStats) => void;
}

interface Attachment {
  stream: Duplex;
  buffer: string[];
  stopStats?: () => void;
  detectedOnline: boolean;
}

/**
 * Keeps one live attachment per running container and fans its output out to
 * every connected websocket.
 *
 * Attaching once (rather than per viewer) matters: Docker attachments are not
 * free, and a popular server can have several staff watching the same console.
 * The last N lines are buffered so a new viewer sees context immediately.
 */
export class ConsoleService extends EventEmitter {
  private readonly attachments = new Map<string, Attachment>();
  private readonly specs = new Map<
    string,
    {
      startupDetection?: string;
      crashDetection?: string;
      stopCommand: string;
      configFiles?: AgentConfigFile[];
    }
  >();
  private readonly log: Logger;

  constructor(
    private readonly docker: DockerService,
    private readonly bufferSize: number,
    logger: Logger,
  ) {
    super();
    this.setMaxListeners(0);
    this.log = logger.child({ component: 'console' });
  }

  registerSpec(
    uuid: string,
    spec: {
      startupDetection?: string;
      crashDetection?: string;
      stopCommand: string;
      configFiles?: AgentConfigFile[];
    },
  ): void {
    this.specs.set(uuid, spec);
  }

  stopCommandFor(uuid: string): string {
    return this.specs.get(uuid)?.stopCommand ?? '^C';
  }

  /** The config-file mappings the panel last sent for this server. */
  configFilesFor(uuid: string): AgentConfigFile[] {
    return this.specs.get(uuid)?.configFiles ?? [];
  }

  history(uuid: string): string[] {
    return this.attachments.get(uuid)?.buffer ?? [];
  }

  /** Attaches to a container's TTY if it is running and not already attached. */
  async attach(uuid: string): Promise<void> {
    if (this.attachments.has(uuid)) return;

    const info = await this.docker.inspect(uuid);
    if (!info?.State.Running) return;

    const stream = await this.docker.attach(uuid);
    const attachment: Attachment = { stream, buffer: [], detectedOnline: false };
    this.attachments.set(uuid, attachment);

    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8');
      const lines = partial.split(/\r?\n/);
      // The trailing element is an incomplete line; hold it until more arrives.
      partial = lines.pop() ?? '';

      for (const line of lines) {
        this.publish(uuid, attachment, line);
      }
    });

    stream.on('end', () => {
      void this.detach(uuid);
      void this.emitCurrentStatus(uuid);
    });

    stream.on('error', (error: Error) => {
      this.log.debug({ err: error, uuid }, 'console stream error');
      void this.detach(uuid);
    });

    // Live resource samples ride the same channel as console output.
    attachment.stopStats = await this.docker
      .streamStats(uuid, (stats) => this.emit('stats', uuid, stats))
      .catch(() => undefined);

    const history = await this.docker.logs(uuid, this.bufferSize).catch(() => []);
    attachment.buffer = history.slice(-this.bufferSize);
  }

  private publish(uuid: string, attachment: Attachment, rawLine: string): void {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0) return;

    attachment.buffer.push(line);
    if (attachment.buffer.length > this.bufferSize) {
      attachment.buffer.splice(0, attachment.buffer.length - this.bufferSize);
    }

    this.emit('line', uuid, line, new Date().toISOString());

    const spec = this.specs.get(uuid);
    if (!spec) return;

    // "Started" for a game server means its own log said so — the container
    // being up only means the process launched.
    if (!attachment.detectedOnline && spec.startupDetection) {
      if (safeMatch(spec.startupDetection, line)) {
        attachment.detectedOnline = true;
        this.emit('status', uuid, ServerStatus.ONLINE);
      }
    }
    if (spec.crashDetection && safeMatch(spec.crashDetection, line)) {
      this.emit('status', uuid, ServerStatus.CRASHED);
    }
  }

  async detach(uuid: string): Promise<void> {
    const attachment = this.attachments.get(uuid);
    if (!attachment) return;

    this.attachments.delete(uuid);
    attachment.stopStats?.();
    attachment.stream.destroy();
  }

  async emitCurrentStatus(uuid: string): Promise<void> {
    const result = await this.docker
      .statusWithReason(uuid)
      .catch(() => ({ status: ServerStatus.OFFLINE, oomKilled: false, exitCode: null }));

    // The console is where someone is looking when this happens, and "Killed"
    // on its own is a dead end. Say what killed it and what to do.
    if (result.oomKilled) {
      this.broadcast(
        uuid,
        '[storm] The server was killed for exceeding its memory limit. Raise it under Settings, or give the server less to do.',
      );
    }

    this.emit('status', uuid, result.status, result.oomKilled ? 'oom' : undefined);
  }

  /** Pushes a line the agent itself produced (install output, notices). */
  broadcast(uuid: string, line: string): void {
    this.emit('line', uuid, line, new Date().toISOString());
  }

  async shutdown(): Promise<void> {
    for (const uuid of [...this.attachments.keys()]) {
      await this.detach(uuid);
    }
  }
}

/**
 * Template-supplied patterns are operator input, but a bad one must degrade to
 * "no detection" rather than crashing the console for everyone.
 */
function safeMatch(pattern: string, line: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(line);
  } catch {
    return line.toLowerCase().includes(pattern.toLowerCase());
  }
}
