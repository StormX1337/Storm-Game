import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

let dotenvLoaded = false;

/** Loads `.env` once per process. Real environment variables always win. */
export function loadEnvFile(path?: string): void {
  if (dotenvLoaded) return;
  loadDotenv(path ? { path } : {});
  dotenvLoaded = true;
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Secrets must be long enough to be worth having. Refusing to boot on a weak
 * secret is deliberate: a panel that silently runs on `changeme` is worse than
 * one that fails loudly during deployment.
 */
const secret = z
  .string()
  .min(32, 'Secret must be at least 32 characters')
  .refine(
    (v) => !/^(changeme|secret|password|storm)$/i.test(v),
    'Refusing to use a placeholder secret',
  );

export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('Storm Panel'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  /**
   * Where the plugin browser looks. Configurable for a panel behind a mirror
   * or without general internet access; the default is Modrinth's own API.
   */
  MODRINTH_API_URL: z.string().url().default('https://api.modrinth.com/v2'),
  /**
   * Hosts a plugin download may come from, comma separated. The panel resolves
   * download URLs from the registry rather than taking them from a customer,
   * and then checks them against this — so a registry that started handing out
   * links to somewhere else cannot turn a node into a fetcher for it.
   */
  MODRINTH_DOWNLOAD_HOSTS: z.string().default('cdn.modrinth.com'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: port.default(8080),
  API_PREFIX: z.string().default('/api'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: booleanish.default(true),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  JWT_SECRET: secret,
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  ENCRYPTION_KEY: secret,
  COOKIE_SECRET: secret,
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.default(false),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(8),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: booleanish.default(false),
  MAIL_FROM: z.string().default('Storm Panel <no-reply@localhost>'),

  BACKUP_LOCAL_PATH: z.string().default('/var/lib/storm/backups'),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(2 * 1024 * 1024 * 1024),

  NODE_HEARTBEAT_TIMEOUT: z.coerce.number().int().min(15).default(90),
  AGENT_REQUEST_TIMEOUT: z.coerce.number().int().min(1000).default(15000),
  /** Accept agent TLS certificates that do not chain to a public CA. */
  AGENT_ALLOW_SELF_SIGNED: booleanish.default(false),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  /* ------------------------------------------------------------ updates -- */

  /** Baked into the image at build time; "unknown" for a hand-built image. */
  STORM_COMMIT: z.string().max(64).default('unknown'),
  STORM_BUILT_AT: z.string().max(64).optional(),
  /** `owner/repo` the panel compares itself against. */
  UPDATE_REPOSITORY: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Must be owner/repo')
    .default('StormX1337/Storm-Game'),
  UPDATE_BRANCH: z.string().max(120).default('main'),
  UPDATE_CHECK_ENABLED: booleanish.default(true),
  /**
   * Shared with the host-side updater. The panel writes a request here; only
   * the host may act on it. Empty disables applying updates from the panel,
   * which is the default — the API deliberately has no way to reach Docker.
   */
  UPDATE_CONTROL_DIR: z.string().max(255).default(''),

  ENABLE_WORKERS: booleanish.default(true),
  /**
   * Multiplies every queue's base concurrency. Raise it on instances dedicated
   * to background work; leave it at 1 on instances that also serve requests,
   * where a backup job competing for the event loop shows up as a laggy
   * console.
   */
  WORKER_CONCURRENCY: z.coerce.number().min(0.25).max(16).default(1),
  ENABLE_SWAGGER: booleanish.default(true),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const agentEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  AGENT_HOST: z.string().default('0.0.0.0'),
  AGENT_PORT: port.default(8081),
  AGENT_TOKEN_ID: z.string().min(4),
  AGENT_TOKEN: z.string().min(16),
  AGENT_SECRET: z.string().min(16),
  PANEL_URL: z.string().url(),
  NODE_UUID: z.string().uuid(),
  DATA_DIRECTORY: z.string().default('/var/lib/storm/servers'),
  BACKUP_DIRECTORY: z.string().default('/var/lib/storm/backups'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  DOCKER_NETWORK: z.string().default('storm_net'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  HEARTBEAT_INTERVAL: z.coerce.number().int().min(5).max(300).default(20),
  SFTP_ENABLED: booleanish.default(true),
  SFTP_PORT: port.default(2022),
  SFTP_HOST_KEY_PATH: z.string().default('/etc/storm/sftp_host_key'),
  TLS_CERT_PATH: z.string().optional(),
  TLS_KEY_PATH: z.string().optional(),
  CONSOLE_BUFFER_LINES: z.coerce.number().int().min(50).max(5000).default(400),
  /** Trust the panel even when its certificate is self-signed (lab setups). */
  PANEL_ALLOW_SELF_SIGNED: booleanish.default(false),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Drops variables that are present but empty.
 *
 * `.env.example` ships several keys with nothing after the `=`, because an
 * operator is meant to fill in the ones they want — and Docker Compose passes
 * those through as `""` rather than leaving them unset. To zod an empty string
 * is a value, so an optional field with a format check rejects it: a fresh
 * install following the guide failed to boot with "ADMIN_EMAIL: Invalid email"
 * for a line the operator had deliberately left blank.
 *
 * Not set and set to nothing are the same thing to whoever wrote the file, so
 * they are the same thing here. A required field still fails, and says it is
 * required rather than complaining about the format of "".
 */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== '') out[key] = value;
  }
  return out;
}

export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(withoutBlanks(source));
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return result.data;
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  loadEnvFile();
  return parseEnv(apiEnvSchema, source);
}

export function loadAgentEnv(source: NodeJS.ProcessEnv = process.env): AgentEnv {
  loadEnvFile();
  return parseEnv(agentEnvSchema, source);
}
