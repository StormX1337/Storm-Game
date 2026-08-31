import fp from 'fastify-plugin';
import pg from 'pg';
import mysql from 'mysql2/promise';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHost } from '@storm/database';
import { ErrorCode } from '@storm/types';
import { AppError } from '../lib/errors.js';

export interface ProvisionResult {
  databaseName: string;
  username: string;
  password: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    databases: DatabaseProvisioner;
  }
}

/**
 * Creates and destroys real database accounts on a configured host.
 *
 * Identifiers are validated against a strict allow-list before interpolation —
 * `CREATE DATABASE` cannot take bound parameters in either engine, so the
 * regex check is the only thing standing between us and SQL injection. Values
 * that are parameterisable (passwords in MySQL) still use placeholders.
 */
export class DatabaseProvisioner {
  constructor(private readonly app: FastifyInstance) {}

  static readonly IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;

  private assertIdentifier(value: string, label: string): void {
    if (!DatabaseProvisioner.IDENTIFIER.test(value)) {
      throw new AppError(
        422,
        ErrorCode.VALIDATION_ERROR,
        `${label} contains characters that are not allowed`,
      );
    }
  }

  private password(host: DatabaseHost): string {
    const password = this.app.encrypter.tryDecrypt(host.passwordEnc);
    if (password === null) {
      throw new AppError(
        500,
        ErrorCode.INTERNAL_ERROR,
        'Database host credentials could not be decrypted',
      );
    }
    return password;
  }

  async provision(
    host: DatabaseHost,
    databaseName: string,
    username: string,
    password: string,
    remoteAccess: string,
  ): Promise<void> {
    this.assertIdentifier(databaseName, 'Database name');
    this.assertIdentifier(username, 'Username');

    if (host.engine === 'POSTGRES') {
      await this.withPostgres(host, async (client) => {
        // Passwords cannot be bound in DDL, so it is escaped as a literal.
        await client.query(`CREATE ROLE "${username}" LOGIN PASSWORD ${quoteLiteral(password)}`);
        await client.query(`CREATE DATABASE "${databaseName}" OWNER "${username}"`);
        await client.query(`REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC`);
        await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${databaseName}" TO "${username}"`);
      });
      return;
    }

    await this.withMysql(host, async (connection) => {
      await connection.query(`CREATE DATABASE \`${databaseName}\``);
      await connection.query(`CREATE USER ?@? IDENTIFIED BY ?`, [username, remoteAccess, password]);
      await connection.query(`GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO ?@?`, [
        username,
        remoteAccess,
      ]);
      await connection.query('FLUSH PRIVILEGES');
    });
  }

  async resetPassword(
    host: DatabaseHost,
    username: string,
    password: string,
    remoteAccess: string,
  ): Promise<void> {
    this.assertIdentifier(username, 'Username');

    if (host.engine === 'POSTGRES') {
      await this.withPostgres(host, async (client) => {
        await client.query(`ALTER ROLE "${username}" WITH PASSWORD ${quoteLiteral(password)}`);
      });
      return;
    }

    await this.withMysql(host, async (connection) => {
      await connection.query('ALTER USER ?@? IDENTIFIED BY ?', [username, remoteAccess, password]);
      await connection.query('FLUSH PRIVILEGES');
    });
  }

  async destroy(
    host: DatabaseHost,
    databaseName: string,
    username: string,
    remoteAccess: string,
  ): Promise<void> {
    this.assertIdentifier(databaseName, 'Database name');
    this.assertIdentifier(username, 'Username');

    if (host.engine === 'POSTGRES') {
      await this.withPostgres(host, async (client) => {
        await client.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`,
          [databaseName],
        );
        await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
        await client.query(`DROP ROLE IF EXISTS "${username}"`);
      });
      return;
    }

    await this.withMysql(host, async (connection) => {
      await connection.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
      await connection.query('DROP USER IF EXISTS ?@?', [username, remoteAccess]);
      await connection.query('FLUSH PRIVILEGES');
    });
  }

  /** Verifies the panel can reach and authenticate against a host. */
  async testConnection(
    host: DatabaseHost,
  ): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      if (host.engine === 'POSTGRES') {
        return await this.withPostgres(host, async (client) => {
          const result = await client.query<{ version: string }>('SELECT version() as version');
          return { ok: true, version: result.rows[0]?.version };
        });
      }
      return await this.withMysql(host, async (connection) => {
        const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() as version');
        return { ok: true, version: rows[0]?.version as string };
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async withPostgres<T>(
    host: DatabaseHost,
    fn: (client: pg.Client) => Promise<T>,
  ): Promise<T> {
    const client = new pg.Client({
      host: host.host,
      port: host.port,
      user: host.username,
      password: this.password(host),
      database: 'postgres',
      connectionTimeoutMillis: 10_000,
    });
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      throw this.wrap(error, host);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private async withMysql<T>(
    host: DatabaseHost,
    fn: (connection: mysql.Connection) => Promise<T>,
  ): Promise<T> {
    let connection: mysql.Connection | null = null;
    try {
      connection = await mysql.createConnection({
        host: host.host,
        port: host.port,
        user: host.username,
        password: this.password(host),
        connectTimeout: 10_000,
        multipleStatements: false,
      });
      return await fn(connection);
    } catch (error) {
      throw this.wrap(error, host);
    } finally {
      await connection?.end().catch(() => undefined);
    }
  }

  private wrap(error: unknown, host: DatabaseHost): AppError {
    if (error instanceof AppError) return error;
    const message = error instanceof Error ? error.message : String(error);
    this.app.log.error({ err: error, host: host.name }, 'database host operation failed');
    return new AppError(
      502,
      ErrorCode.SERVICE_UNAVAILABLE,
      `Database host "${host.name}" rejected the operation: ${message.slice(0, 200)}`,
    );
  }
}

/** Escapes a Postgres string literal (doubling single quotes). */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export default fp(
  async function databaseProvisionerPlugin(app: FastifyInstance) {
    app.decorate('databases', new DatabaseProvisioner(app));
  },
  { name: 'storm-databases', dependencies: ['storm-env'] },
);
