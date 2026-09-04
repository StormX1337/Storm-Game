import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ServerStatus } from '@storm/types';
import { ConsoleService } from '../src/services/console.service.js';
import type { DockerService } from '../src/services/docker.service.js';

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const log = {
  child: () => log,
  debug: () => undefined,
  warn: () => undefined,
} as never;

/**
 * One attachment per container, and the log matching that runs on every line.
 *
 * The agent attaches to a container from three places — a websocket opening, a
 * server starting, and the heartbeat re-attaching anything that came up
 * outside its control. They are all fire-and-forget, so two of them landing
 * together is ordinary, not exotic.
 */
function stubDocker(options: { running?: boolean; onAttach?: () => void } = {}): {
  docker: DockerService;
  streams: PassThrough[];
  attachCount: () => number;
  statsStopped: () => number;
} {
  const streams: PassThrough[] = [];
  let attaches = 0;
  let stopped = 0;

  const docker = {
    async inspect() {
      // A tick of real asynchrony, which is what opens the window two callers
      // used to race through.
      await new Promise((resolve) => setImmediate(resolve));
      return { State: { Running: options.running ?? true } };
    },
    async attach() {
      attaches += 1;
      options.onAttach?.();
      await new Promise((resolve) => setImmediate(resolve));
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
    async streamStats() {
      return () => {
        stopped += 1;
      };
    },
    async logs() {
      return [];
    },
    async statusWithReason() {
      return { status: ServerStatus.OFFLINE, oomKilled: false, exitCode: 0 };
    },
  } as unknown as DockerService;

  return { docker, streams, attachCount: () => attaches, statsStopped: () => stopped };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the console attaches once per container', async (t) => {
  await t.test('two callers arriving together produce one attachment', async () => {
    // Both used to pass the "already attached?" check while the other was
    // still awaiting Docker, so the container ended up with two live
    // attachments: every console line delivered twice, and the first
    // attachment's stream and stats poller leaked because the map only kept
    // the second.
    const { docker, attachCount } = stubDocker();
    const console = new ConsoleService(docker, 100, log);

    await Promise.all([console.attach(UUID), console.attach(UUID)]);

    assert.equal(attachCount(), 1);
    await console.shutdown();
  });

  await t.test('a line is delivered once, not once per racing caller', async () => {
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 100, log);
    const lines: string[] = [];
    console.on('line', (_uuid: string, line: string) => lines.push(line));

    await Promise.all([console.attach(UUID), console.attach(UUID), console.attach(UUID)]);
    // Docker sends the same output to every attachment it holds, so a second
    // one is a second copy of every line.
    for (const stream of streams) stream.write('Server started\n');
    await settle();

    assert.deepEqual(lines, ['Server started']);
    await console.shutdown();
  });

  await t.test('attaching again after a detach still works', async () => {
    // The guard must not become a latch: a container that stops and starts
    // again needs a fresh attachment.
    const { docker, attachCount } = stubDocker();
    const console = new ConsoleService(docker, 100, log);

    await console.attach(UUID);
    await console.detach(UUID);
    await console.attach(UUID);

    assert.equal(attachCount(), 2);
    await console.shutdown();
  });

  await t.test('a failed attach does not block the next attempt', async () => {
    // A container that was not running yet must not leave a rejected promise
    // parked in the way of the retry that follows.
    let running = false;
    const docker = stubDocker({ running: false });
    const service = new ConsoleService(
      {
        ...(docker.docker as unknown as Record<string, unknown>),
        async inspect() {
          await new Promise((resolve) => setImmediate(resolve));
          return { State: { Running: running } };
        },
      } as unknown as DockerService,
      100,
      log,
    );

    await service.attach(UUID);
    assert.equal(docker.attachCount(), 0, 'attached to a container that was not running');

    running = true;
    await service.attach(UUID);
    assert.equal(docker.attachCount(), 1);
    await service.shutdown();
  });

  await t.test('detaching stops the stats poller with the stream', async () => {
    const { docker, statsStopped } = stubDocker();
    const console = new ConsoleService(docker, 100, log);

    await console.attach(UUID);
    await console.detach(UUID);

    assert.equal(statsStopped(), 1);
  });

  /* ------------------------------------------------ what a line means -- */

  await t.test('says a server is online when its own log says so', async () => {
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 100, log);
    const statuses: string[] = [];
    console.on('status', (_uuid: string, status: string) => statuses.push(status));

    console.registerSpec(UUID, { startupDetection: 'Done \\(', stopCommand: 'stop' });
    await console.attach(UUID);
    streams[0]?.write('[12:00:00] Done (3.5s)! For help, type "help"\n');
    await settle();

    assert.deepEqual(statuses, [ServerStatus.ONLINE]);
    await console.shutdown();
  });

  await t.test('says it once, not on every line that matches afterwards', async () => {
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 100, log);
    const statuses: string[] = [];
    console.on('status', (_uuid: string, status: string) => statuses.push(status));

    console.registerSpec(UUID, { startupDetection: 'Done', stopCommand: 'stop' });
    await console.attach(UUID);
    streams[0]?.write('Done (1s)\nDone again\nDone once more\n');
    await settle();

    assert.deepEqual(statuses, [ServerStatus.ONLINE]);
    await console.shutdown();
  });

  await t.test('falls back to a plain substring when the pattern is not a regex', async () => {
    // Detection patterns come from templates, and templates come from
    // Pterodactyl eggs written by strangers. A pattern that will not compile
    // has to degrade to something, not take the console down with it.
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 100, log);
    const statuses: string[] = [];
    console.on('status', (_uuid: string, status: string) => statuses.push(status));

    console.registerSpec(UUID, { startupDetection: 'Ready ([unclosed', stopCommand: 'stop' });
    await console.attach(UUID);
    streams[0]?.write('Ready ([unclosed and then some\n');
    await settle();

    assert.deepEqual(statuses, [ServerStatus.ONLINE]);
    await console.shutdown();
  });

  await t.test('only reads the start of a very long line', async () => {
    // Log lines are attacker-influenced — a customer types into their own
    // console and the server echoes it back. Handing an unbounded string to a
    // pattern somebody else wrote is how one server's log stalls the agent
    // that runs everybody's.
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 100, log);
    const statuses: string[] = [];
    console.on('status', (_uuid: string, status: string) => statuses.push(status));

    console.registerSpec(UUID, { startupDetection: 'READY', stopCommand: 'stop' });
    await console.attach(UUID);
    streams[0]?.write(`${'x'.repeat(20_000)}READY\n`);
    await settle();

    assert.deepEqual(statuses, [], 'matched past the end of the bounded prefix');
    await console.shutdown();
  });

  await t.test('keeps the buffer to its size, oldest lines first', async () => {
    const { docker, streams } = stubDocker();
    const console = new ConsoleService(docker, 3, log);

    await console.attach(UUID);
    streams[0]?.write('one\ntwo\nthree\nfour\nfive\n');
    await settle();

    assert.deepEqual(console.history(UUID), ['three', 'four', 'five']);
    await console.shutdown();
  });
});
