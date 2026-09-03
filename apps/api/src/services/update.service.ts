import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { STORM_VERSION } from '@storm/config';
import { badRequest, conflict, internal } from '../lib/errors.js';

/**
 * Panel updates.
 *
 * Two halves, deliberately separated. Checking is safe — one outbound HTTPS
 * call to a repository host — and always available. Applying is not: it
 * replaces the running code and rebuilds containers, which needs the Docker
 * daemon and the host's checkout.
 *
 * The API has neither, and it stays that way. Handing the panel a Docker socket
 * would mean that anyone who finds a hole in a web endpoint owns the machine
 * and every customer's server on it. Instead the panel writes a request into a
 * directory it shares with the host, and a host-side service decides whether to
 * act on it. The panel can ask; only the host can execute.
 */

export interface UpdateCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: string;
  url: string;
}

export interface UpdateStatus {
  /** What this image was built from. */
  current: { version: string; commit: string; shortCommit: string; builtAt: string | null };
  available: {
    checked: boolean;
    /**
     * Whether the running version can be compared at all. An image built with
     * no commit stamp cannot be, and "not up to date" would then read as "an
     * update is available" when the honest answer is that nobody knows.
     */
    comparable: boolean;
    upToDate: boolean;
    commit: string | null;
    shortCommit: string | null;
    behindBy: number;
    commits: UpdateCommit[];
  };
  /** Whether a click can actually do anything on this deployment. */
  canApply: boolean;
  reason: string | null;
  repository: string;
  branch: string;
  lastCheckedAt: string | null;
  job: UpdateJob | null;
}

export interface UpdateJob {
  id: string;
  state: 'requested' | 'running' | 'succeeded' | 'failed';
  requestedCommit: string;
  requestedBy: string;
  requestedAt: string;
  /**
   * Set local edits aside before updating.
   *
   * Off unless somebody ticked it: a checkout edited in place stops an update
   * for a reason, and stashing it on a schedule would be deciding for the
   * operator that whatever they changed did not matter.
   */
  stashLocal?: boolean;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  log?: string[];
}

const CACHE_KEY = 'storm:update:latest';
const CACHE_SECONDS = 900;
const REQUEST_FILE = 'request.json';
const STATUS_FILE = 'status.json';
const HEARTBEAT_FILE = 'updater.json';

/**
 * How stale the updater's heartbeat may be before it counts as gone. It writes
 * one every 15 seconds by default; six missed beats is a process that has died
 * or a host that has stopped, not a slow one.
 */
const HEARTBEAT_MAX_AGE_MS = 90_000;

export class UpdateService {
  constructor(private readonly app: FastifyInstance) {}

  private get controlDir(): string | null {
    const dir = this.app.env.UPDATE_CONTROL_DIR.trim();
    return dir === '' ? null : dir;
  }

  async status(): Promise<UpdateStatus> {
    const env = this.app.env;
    const commit = env.STORM_COMMIT;

    const current = {
      version: STORM_VERSION,
      commit,
      shortCommit: commit.slice(0, 7),
      builtAt: env.STORM_BUILT_AT ?? null,
    };

    const job = await this.readJob();
    const { canApply, reason } = await this.applicability(job);

    if (!env.UPDATE_CHECK_ENABLED) {
      return {
        current,
        available: {
          checked: false,
          comparable: false,
          upToDate: true,
          commit: null,
          shortCommit: null,
          behindBy: 0,
          commits: [],
        },
        canApply,
        reason: reason ?? 'Update checking is switched off (UPDATE_CHECK_ENABLED).',
        repository: env.UPDATE_REPOSITORY,
        branch: env.UPDATE_BRANCH,
        lastCheckedAt: null,
        job,
      };
    }

    const remote = await this.latest();

    // An image built by hand carries no commit, so there is nothing to compare
    // against — say that rather than claiming an update exists.
    const comparable = commit !== 'unknown' && commit.length >= 7;
    const upToDate = comparable && remote !== null && remote.head === commit;

    return {
      current,
      available: {
        checked: remote !== null,
        comparable,
        upToDate,
        commit: remote?.head ?? null,
        shortCommit: remote?.head.slice(0, 7) ?? null,
        behindBy: comparable ? (remote?.behindBy ?? 0) : 0,
        commits: remote?.commits ?? [],
      },
      canApply: canApply && !upToDate && comparable,
      reason: !comparable
        ? 'This image was built without a commit stamp, so the panel cannot tell which version it runs.'
        : reason,
      repository: env.UPDATE_REPOSITORY,
      branch: env.UPDATE_BRANCH,
      lastCheckedAt: remote?.checkedAt ?? null,
      job,
    };
  }

  /** Why applying would not work, so the UI can explain instead of failing. */
  private async applicability(
    job: UpdateJob | null,
  ): Promise<{ canApply: boolean; reason: string | null }> {
    const dir = this.controlDir;
    if (!dir) {
      return {
        canApply: false,
        reason:
          'No updater is connected. Install the host-side updater to apply updates from here — the panel has no access to Docker by design.',
      };
    }

    try {
      await fs.access(dir);
    } catch {
      return { canApply: false, reason: `The updater directory ${dir} is not mounted.` };
    }

    // Compose mounts the directory whether or not anyone installed an updater,
    // so its existence proves nothing. Only a recent heartbeat does: without
    // one, a click would write a request that nothing ever reads, and the panel
    // would sit at "requested" forever looking broken.
    const beat = await this.readHeartbeat(dir);
    if (!beat) {
      return {
        canApply: false,
        reason:
          'No updater is connected. Install the host-side updater to apply updates from here — the panel has no access to Docker by design.',
      };
    }
    if (Date.now() - beat > HEARTBEAT_MAX_AGE_MS) {
      const minutes = Math.round((Date.now() - beat) / 60_000);
      return {
        canApply: false,
        reason: `The updater last checked in ${minutes} minute(s) ago. Check it with: systemctl status storm-updater`,
      };
    }

    if (job && (job.state === 'requested' || job.state === 'running')) {
      return { canApply: false, reason: 'An update is already in progress.' };
    }

    return { canApply: true, reason: null };
  }

  /** When the host-side updater last said it was alive, or null. */
  private async readHeartbeat(dir: string): Promise<number | null> {
    try {
      const raw = await fs.readFile(path.join(dir, HEARTBEAT_FILE), 'utf8');
      const seenAt = (JSON.parse(raw) as { seenAt?: string }).seenAt;
      const at = seenAt ? Date.parse(seenAt) : Number.NaN;
      return Number.isFinite(at) ? at : null;
    } catch {
      return null;
    }
  }

  /**
   * The branch head and the commits between it and this build. Cached: the
   * dashboard asks on every load and the API is rate limited per IP.
   */
  private async latest(): Promise<{
    head: string;
    behindBy: number;
    commits: UpdateCommit[];
    checkedAt: string;
  } | null> {
    const cached = await this.app.redis.get(CACHE_KEY).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as ReturnType<UpdateService['latest']> extends Promise<infer T>
          ? T
          : never;
      } catch {
        // Fall through and ask again.
      }
    }

    const { UPDATE_REPOSITORY: repo, UPDATE_BRANCH: branch, STORM_COMMIT: commit } = this.app.env;

    // The repository is operator configuration validated as `owner/repo`, never
    // user input, and the host is fixed — there is no URL here to redirect.
    const base = `https://api.github.com/repos/${repo}`;
    const url =
      commit !== 'unknown' && commit.length >= 7
        ? `${base}/compare/${encodeURIComponent(commit)}...${encodeURIComponent(branch)}`
        : `${base}/commits/${encodeURIComponent(branch)}`;

    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'storm-panel',
          ...(process.env.UPDATE_TOKEN
            ? { authorization: `Bearer ${process.env.UPDATE_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.app.log.warn({ status: response.status, repo }, 'update check failed');
        return null;
      }

      const body = (await response.json()) as Record<string, unknown>;
      const result = this.parse(body, repo);
      if (result) {
        await this.app.redis
          .setex(CACHE_KEY, CACHE_SECONDS, JSON.stringify(result))
          .catch(() => undefined);
      }
      return result;
    } catch (error) {
      this.app.log.warn({ err: error }, 'update check failed');
      return null;
    }
  }

  private parse(
    body: Record<string, unknown>,
    repo: string,
  ): { head: string; behindBy: number; commits: UpdateCommit[]; checkedAt: string } | null {
    const checkedAt = new Date().toISOString();

    // /compare returns the range; /commits/<branch> returns a single commit.
    if (typeof body.ahead_by === 'number' || Array.isArray(body.commits)) {
      const raw = Array.isArray(body.commits) ? body.commits : [];
      const commits = raw
        .map((entry) => this.toCommit(entry as Record<string, unknown>, repo))
        .reverse();
      const head =
        (body.commits as Record<string, unknown>[] | undefined)?.at(-1)?.sha ??
        commits[0]?.sha ??
        null;
      if (typeof head !== 'string') return null;
      return {
        head,
        behindBy: typeof body.ahead_by === 'number' ? body.ahead_by : commits.length,
        commits,
        checkedAt,
      };
    }

    if (typeof body.sha === 'string') {
      return { head: body.sha, behindBy: 0, commits: [this.toCommit(body, repo)], checkedAt };
    }

    return null;
  }

  private toCommit(entry: Record<string, unknown>, repo: string): UpdateCommit {
    const sha = typeof entry.sha === 'string' ? entry.sha : '';
    const commit = (entry.commit ?? {}) as Record<string, unknown>;
    const author = (commit.author ?? {}) as Record<string, unknown>;
    const message = typeof commit.message === 'string' ? commit.message : '';

    return {
      sha,
      shortSha: sha.slice(0, 7),
      // Only the subject: a body of several paragraphs does not belong in a list.
      subject: message.split('\n')[0]?.slice(0, 200) ?? '',
      author: typeof author.name === 'string' ? author.name : 'unknown',
      committedAt: typeof author.date === 'string' ? author.date : new Date().toISOString(),
      url: `https://github.com/${repo}/commit/${sha}`,
    };
  }

  /* --------------------------------------------------------- applying -- */

  async request(
    targetCommit: string,
    requestedBy: string,
    options: { stashLocal?: boolean } = {},
  ): Promise<UpdateJob> {
    const dir = this.controlDir;
    if (!dir) {
      throw badRequest(
        'No updater is connected to this deployment. Updates are applied from the host, on purpose.',
      );
    }

    if (!/^[0-9a-f]{7,40}$/.test(targetCommit)) {
      throw badRequest('That does not look like a commit to update to.');
    }

    const existing = await this.readJob();
    if (existing && (existing.state === 'requested' || existing.state === 'running')) {
      throw conflict('An update is already in progress.');
    }

    const job: UpdateJob = {
      id: `upd_${Date.now().toString(36)}`,
      state: 'requested',
      requestedCommit: targetCommit,
      requestedBy,
      requestedAt: new Date().toISOString(),
      ...(options.stashLocal ? { stashLocal: true } : {}),
    };

    try {
      await fs.writeFile(path.join(dir, REQUEST_FILE), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.app.log.error({ err: error, dir }, 'could not write the update request');
      throw internal('The updater directory could not be written to.');
    }

    return job;
  }

  /** What the host-side updater last reported. */
  private async readJob(): Promise<UpdateJob | null> {
    const dir = this.controlDir;
    if (!dir) return null;

    for (const file of [STATUS_FILE, REQUEST_FILE]) {
      try {
        const raw = await fs.readFile(path.join(dir, file), 'utf8');
        return JSON.parse(raw) as UpdateJob;
      } catch {
        // Try the next one; neither existing is the normal idle state.
      }
    }
    return null;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    updates: UpdateService;
  }
}
