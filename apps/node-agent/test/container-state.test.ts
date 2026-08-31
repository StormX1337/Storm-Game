import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerStatus } from '@storm/types';
import { DockerService } from '../src/services/docker.service.js';

/**
 * How a stopped container is read.
 *
 * Docker distinguishes a process that failed from one the kernel killed for
 * exceeding its memory limit. The second is the common way a game server dies —
 * and the only crash its owner can fix themselves. Collapsing both into CRASHED
 * left the panel saying "stopped unexpectedly" beside a console showing a bare
 * "Killed".
 */
describe('reading why a container stopped', () => {
  /** A DockerService whose inspect returns exactly this state. */
  function withState(state: Record<string, unknown> | null): DockerService {
    const service = Object.create(DockerService.prototype) as DockerService;
    (service as unknown as { inspect: () => Promise<unknown> }).inspect = async () =>
      state === null ? null : { State: state };
    return service;
  }

  it('calls an out-of-memory kill what it is', async () => {
    const result = await withState({
      Running: false,
      Restarting: false,
      OOMKilled: true,
      ExitCode: 137,
      FinishedAt: '2026-08-31T12:00:00Z',
    }).statusWithReason('x');

    assert.equal(result.status, ServerStatus.CRASHED);
    assert.equal(result.oomKilled, true);
  });

  it('treats exit 137 as one too, since cgroup v2 does not always set the flag', async () => {
    const result = await withState({
      Running: false,
      Restarting: false,
      OOMKilled: false,
      ExitCode: 137,
      FinishedAt: '2026-08-31T12:00:00Z',
    }).statusWithReason('x');

    assert.equal(result.status, ServerStatus.CRASHED);
    assert.equal(result.oomKilled, true);
  });

  it('does not blame memory for an ordinary failure', async () => {
    const result = await withState({
      Running: false,
      Restarting: false,
      OOMKilled: false,
      ExitCode: 1,
      FinishedAt: '2026-08-31T12:00:00Z',
    }).statusWithReason('x');

    assert.equal(result.status, ServerStatus.CRASHED);
    assert.equal(result.oomKilled, false);
    assert.equal(result.exitCode, 1);
  });

  it('reads a clean stop as offline, not a crash', async () => {
    const result = await withState({
      Running: false,
      Restarting: false,
      OOMKilled: false,
      ExitCode: 0,
      FinishedAt: '2026-08-31T12:00:00Z',
    }).statusWithReason('x');

    assert.equal(result.status, ServerStatus.OFFLINE);
    assert.equal(result.oomKilled, false);
  });

  it('reports a running container as online and a restarting one as starting', async () => {
    const running = await withState({ Running: true, Restarting: false }).statusWithReason('x');
    assert.equal(running.status, ServerStatus.ONLINE);

    const restarting = await withState({ Running: false, Restarting: true }).statusWithReason('x');
    assert.equal(restarting.status, ServerStatus.STARTING);
  });

  it('reports a container that does not exist as offline', async () => {
    const result = await withState(null).statusWithReason('x');
    assert.equal(result.status, ServerStatus.OFFLINE);
  });

  it('does not call a never-started container crashed', async () => {
    // A created-but-never-run container has exit code 0 and the zero time.
    const result = await withState({
      Running: false,
      Restarting: false,
      OOMKilled: false,
      ExitCode: 0,
      FinishedAt: '0001-01-01T00:00:00Z',
    }).statusWithReason('x');

    assert.equal(result.status, ServerStatus.OFFLINE);
  });
});
