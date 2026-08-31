import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken } from '@storm/security';
import { notFound } from '../lib/errors.js';
import { ErrorCode } from '@storm/types';

/**
 * Getting an agent's configuration onto a node used to mean moving a file
 * there — which assumes a machine that can hold one, and an operator sitting at
 * it. From a phone there is no such machine: there is an SSH session and a
 * clipboard.
 *
 * So the panel hands out a claim instead. It is short-lived, single-use, and
 * worth exactly one node's configuration; the installer redeems it over HTTPS
 * and writes the file itself. The credential is never on the operator's device
 * and never in their scrollback.
 */

/** Long enough to walk to the machine and paste, short enough to be worthless later. */
const CLAIM_TTL_SECONDS = 900;

const CLAIM_PREFIX = 'storm:node-bootstrap:';

/**
 * Redis holds the digest, not the claim. A dump of the key space is then not a
 * set of working claims, exactly as the node tokens themselves are stored.
 */
function claimKey(claim: string): string {
  return CLAIM_PREFIX + createHash('sha256').update(claim).digest('hex');
}

export interface NodeConfiguration {
  configuration: string;
  filename: string;
}

/**
 * Mints a node token and renders the agent.env around it. The plaintext token
 * exists only in what this returns; the database keeps a digest.
 */
export async function issueNodeConfiguration(
  app: FastifyInstance,
  nodeId: string,
): Promise<{ config: NodeConfiguration; nodeName: string }> {
  const node = await app.prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound('Node was not found', ErrorCode.NODE_NOT_FOUND);

  const tokenId = generateToken(8).slice(0, 16);
  const token = generateToken(32);
  const secret = generateToken(32);

  // Every previous configuration token the node never authenticated with is
  // revoked alongside. Those are the ones left behind by opening the dialog and
  // closing it again, and each was a working credential for the life of the
  // node. A token in actual service is untouched, so re-reading the
  // configuration cannot take a running node offline.
  await app.prisma.$transaction([
    app.prisma.nodeToken.updateMany({
      where: { nodeId: node.id, name: 'configuration', revokedAt: null, lastUsedAt: null },
      data: { revokedAt: new Date() },
    }),
    app.prisma.nodeToken.create({
      data: {
        nodeId: node.id,
        name: 'configuration',
        tokenId,
        tokenHash: hashToken(token),
        secretEnc: app.encrypter.encrypt(secret),
      },
    }),
  ]);

  const configuration =
    [
      `# Storm Node Agent configuration for ${node.name}`,
      `# Generated ${new Date().toISOString()}`,
      `NODE_UUID=${node.uuid}`,
      `PANEL_URL=${app.env.APP_URL}`,
      `AGENT_HOST=0.0.0.0`,
      `AGENT_PORT=${node.agentPort}`,
      `AGENT_TOKEN_ID=${tokenId}`,
      `AGENT_TOKEN=${token}`,
      `AGENT_SECRET=${secret}`,
      `DATA_DIRECTORY=${node.dataDirectory}`,
      `BACKUP_DIRECTORY=${node.backupDirectory}`,
      `SFTP_ENABLED=true`,
      `SFTP_PORT=${node.sftpPort}`,
      `DOCKER_NETWORK=storm_net`,
      `LOG_LEVEL=info`,
    ].join('\n') + '\n';

  return { config: { configuration, filename: 'storm-agent.env' }, nodeName: node.name };
}

/** A claim the installer can redeem once, for this node, within the window. */
export async function createBootstrapClaim(
  app: FastifyInstance,
  nodeId: string,
): Promise<{ claim: string; command: string; expiresInSeconds: number }> {
  const claim = generateToken(24);

  await app.redis.set(claimKey(claim), nodeId, 'EX', CLAIM_TTL_SECONDS);

  // One line, because it has to survive being pasted into a phone keyboard.
  const command = `curl -fsSL ${app.env.APP_URL}/install/node.sh | sudo bash -s -- --panel-url ${app.env.APP_URL} --claim ${claim}`;

  return { claim, command, expiresInSeconds: CLAIM_TTL_SECONDS };
}

/**
 * Redeems a claim. Deletes it first: two installers racing on the same claim
 * must not both walk away with a working credential, and a redemption that
 * fails afterwards is better than one that can be replayed.
 */
export async function redeemBootstrapClaim(
  app: FastifyInstance,
  claim: string,
): Promise<{ config: NodeConfiguration; nodeId: string; nodeName: string }> {
  const key = claimKey(claim);

  // GETDEL is atomic, so only one caller can ever see the node id.
  const nodeId = await app.redis.getdel(key);
  if (!nodeId) {
    throw notFound('That installation link has expired or has already been used');
  }

  const { config, nodeName } = await issueNodeConfiguration(app, nodeId);
  return { config, nodeId, nodeName };
}
