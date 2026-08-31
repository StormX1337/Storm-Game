import { Agent, request as undiciRequest, type Dispatcher } from 'undici';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Node, NodeToken } from '@storm/database';
import { signRequest } from '@storm/security';
import { ErrorCode } from '@storm/types';
import { AppError } from '../lib/errors.js';

export interface AgentRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** Return the raw response instead of parsing JSON (file downloads). */
  raw?: boolean;
  stream?: Readable;
  headers?: Record<string, string>;
}

export type NodeWithToken = Node & { tokens: NodeToken[] };

/**
 * Talks to a Storm Node Agent.
 *
 * Panel -> agent: the token id in the Authorization header plus an HMAC over
 * method, path, timestamp and body, so a captured request cannot be replayed
 * against a different endpoint or after the 5-minute window, and the shared
 * secret is never transmitted.
 *
 * Agent -> panel (heartbeat, SFTP credential checks): `<tokenId>.<token>`,
 * verified against the stored token digest.
 */
export class AgentClient {
  private readonly dispatcher: Dispatcher;

  constructor(private readonly app: FastifyInstance) {
    this.dispatcher = new Agent({
      connect: {
        // Node agents commonly run with an internally-issued certificate.
        rejectUnauthorized: !app.env.AGENT_ALLOW_SELF_SIGNED,
        timeout: 10_000,
      },
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  }

  baseUrl(node: Pick<Node, 'scheme' | 'hostname' | 'agentPort'>): string {
    return `${node.scheme}://${node.hostname}:${node.agentPort}`;
  }

  websocketUrl(node: Pick<Node, 'scheme' | 'hostname' | 'agentPort'>, path: string): string {
    const protocol = node.scheme === 'https' ? 'wss' : 'ws';
    return `${protocol}://${node.hostname}:${node.agentPort}${path}`;
  }

  /** Resolves the active token for a node, or throws if none is usable. */
  async credentials(nodeId: string): Promise<{ authorization: string; secret: string }> {
    const token = await this.app.prisma.nodeToken.findFirst({
      where: {
        nodeId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!token) {
      throw new AppError(
        503,
        ErrorCode.NODE_UNREACHABLE,
        'This node has no active token. Regenerate its configuration and restart the agent.',
      );
    }
    const secret = this.app.encrypter.tryDecrypt(token.secretEnc);
    if (!secret) {
      throw new AppError(500, ErrorCode.INTERNAL_ERROR, 'Node token secret could not be decrypted');
    }
    // Only the token id travels in the header — possession of the shared secret
    // is proven by the HMAC signature, so the secret never crosses the wire.
    return { authorization: `Bearer ${token.tokenId}`, secret };
  }

  async request<T>(node: Node, path: string, options: AgentRequestOptions = {}): Promise<T> {
    const response = await this.rawRequest(node, path, options);
    const text = await response.body.text();

    if (response.statusCode >= 400) {
      throw this.toAppError(response.statusCode, text, node);
    }
    if (!text) return undefined as T;
    try {
      const parsed = JSON.parse(text) as { success?: boolean; data?: T };
      return (parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed) as T;
    } catch {
      throw new AppError(
        502,
        ErrorCode.NODE_UNREACHABLE,
        'The node agent returned an unreadable response',
      );
    }
  }

  /** Lower level call that hands back the undici response (for streaming). */
  async rawRequest(
    node: Node,
    path: string,
    options: AgentRequestOptions = {},
  ): Promise<Dispatcher.ResponseData> {
    const { authorization, secret } = await this.credentials(node.id);
    const method = options.method ?? 'GET';
    const timestamp = String(Math.floor(Date.now() / 1000));

    const url = new URL(`${this.baseUrl(node)}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const serialisedBody = options.stream
      ? ''
      : options.body === undefined
        ? ''
        : JSON.stringify(options.body);

    const signature = signRequest(secret, {
      method,
      // Sign the path with its query string so parameters cannot be swapped.
      path: `${url.pathname}${url.search}`,
      timestamp,
      body: serialisedBody,
    });

    const headers: Record<string, string> = {
      authorization,
      'x-storm-timestamp': timestamp,
      'x-storm-signature': signature,
      accept: 'application/json',
      ...options.headers,
    };
    if (!options.stream && serialisedBody) headers['content-type'] = 'application/json';

    try {
      return await undiciRequest(url, {
        method,
        headers,
        body: options.stream ?? (serialisedBody || undefined),
        dispatcher: this.dispatcher,
        headersTimeout: options.timeoutMs ?? this.app.env.AGENT_REQUEST_TIMEOUT,
        bodyTimeout: options.raw ? 0 : (options.timeoutMs ?? this.app.env.AGENT_REQUEST_TIMEOUT),
      });
    } catch (error) {
      this.app.log.warn({ err: error, node: node.name, path }, 'node agent request failed');
      throw new AppError(
        503,
        ErrorCode.NODE_UNREACHABLE,
        `Node "${node.name}" is not reachable right now`,
        { cause: error },
      );
    }
  }

  private toAppError(statusCode: number, text: string, node: Node): AppError {
    let message = `Node "${node.name}" rejected the request`;
    let code: string = ErrorCode.NODE_UNREACHABLE;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) message = parsed.error.message;
      if (parsed.error?.code) code = parsed.error.code;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    // Client errors from the agent are the caller's problem; 5xx is the node's.
    const status = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
    return new AppError(status, code, message);
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    agents: AgentClient;
  }
}
