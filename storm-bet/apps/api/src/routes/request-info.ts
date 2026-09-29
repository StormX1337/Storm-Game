import type { AuditActor } from '@storm-bet/database';
import type { FastifyRequest } from 'fastify';
import { requireSession } from '../plugins/auth';
import type { RequestInfo } from '../services/auth';

export function requestInfo(request: FastifyRequest, auditIp: boolean): RequestInfo {
  const userAgent = request.headers['user-agent']?.slice(0, 400) ?? null;
  return { ip: request.ip, userAgent, auditIp: auditIp ? request.ip : null };
}

export function actorOf(request: FastifyRequest, auditIp: boolean): AuditActor & { id: string } {
  const session = requireSession(request);
  return {
    id: session.userId,
    role: session.role,
    ip: auditIp ? request.ip : null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
