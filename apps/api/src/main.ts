import { loadApiEnv, EnvValidationError } from '@storm/config';
import { buildApp } from './app.js';
import { startWorkers } from './workers/index.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadApiEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Fail loudly and readably: a mis-set secret must never boot silently.
      console.error(`\n✖ Storm Panel API cannot start.\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const app = await buildApp({ env });

  if (env.ENABLE_WORKERS) {
    await startWorkers(app);
  } else {
    app.log.info('background workers are disabled for this instance');
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    // Give in-flight requests a moment, then exit regardless so a stuck
    // connection cannot block a rolling deploy.
    const timer = setTimeout(() => {
      app.log.warn('forced shutdown after timeout');
      process.exit(1);
    }, 15_000);
    timer.unref();

    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  await app.listen({ host: env.API_HOST, port: env.API_PORT });
  app.log.info(
    { port: env.API_PORT, docs: env.ENABLE_SWAGGER ? `${env.APP_URL}/api/docs` : null },
    'Storm Panel API is ready',
  );
}

void main();
