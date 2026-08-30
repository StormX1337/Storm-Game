import { Agent, request } from 'undici';
import type { FastifyBaseLogger as Logger } from 'fastify';
import type { AgentHeartbeat, ServerStatus } from '@storm/types';

export interface PanelClientOptions {
  panelUrl: string;
  tokenId: string;
  token: string;
  allowSelfSigned: boolean;
  logger: Logger;
}

export interface SftpAuthResult {
  uuid: string;
  serverId: string;
  writable: boolean;
}

/**
 * The agent's outbound client to the panel.
 *
 * This direction authenticates with `<tokenId>.<token>`, which the panel
 * verifies against a stored digest — the inverse of the panel -> agent
 * direction, which signs with the shared HMAC secret.
 */
export class PanelClient {
  private readonly dispatcher: Agent;
  private readonly log: Logger;
  private readonly base: string;

  constructor(private readonly options: PanelClientOptions) {
    this.base = options.panelUrl.replace(/\/+$/, '');
    this.log = options.logger.child({ component: 'panel-client' });
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: !options.allowSelfSigned, timeout: 10_000 },
    });
  }

  private get authorization(): string {
    return `Bearer ${this.options.tokenId}.${this.options.token}`;
  }

  private async post<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T | null> {
    try {
      const response = await request(`${this.base}/api/v1/internal${path}`, {
        method: 'POST',
        headers: {
          authorization: this.authorization,
          'content-type': 'application/json',
          'user-agent': 'StormNodeAgent/1.0',
        },
        body: JSON.stringify(body),
        dispatcher: this.dispatcher,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      const text = await response.body.text();
      if (response.statusCode >= 400) {
        this.log.warn(
          { path, status: response.statusCode, body: text.slice(0, 200) },
          'panel rejected request',
        );
        return null;
      }

      const parsed = JSON.parse(text) as { data?: T };
      return (parsed.data ?? null) as T | null;
    } catch (error) {
      this.log.warn({ err: error, path }, 'panel request failed');
      return null;
    }
  }

  async heartbeat(payload: AgentHeartbeat): Promise<void> {
    await this.post('/heartbeat', payload);
  }

  async reportStatus(uuid: string, status: ServerStatus): Promise<void> {
    await this.post(`/servers/${uuid}/state`, { status });
  }

  async reportStats(uuid: string, stats: Record<string, unknown>): Promise<void> {
    await this.post(`/servers/${uuid}/stats`, stats, 8000);
  }

  /**
   * Validates SFTP credentials against the panel. The agent deliberately holds
   * no copy of customer passwords: every login is checked live, so revoking a
   * server or suspending an account takes effect immediately.
   */
  async authenticateSftp(username: string, password: string): Promise<SftpAuthResult | null> {
    return this.post<SftpAuthResult>('/sftp/auth', { username, password }, 10_000);
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
