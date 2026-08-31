import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { SEED_TEMPLATES } from '../src/seed/templates.js';

/**
 * Install scripts are shell that runs on a customer's node against APIs nobody
 * here controls. They rot silently: PaperMC retired its v2 API and every
 * Minecraft install started failing with "curl: (22)" and an exit code, which
 * says nothing about what broke or what to do.
 *
 * So these run the real script against a stand-in for those APIs. What is being
 * checked is that it asks the right service, picks the newest build, survives
 * the upstream renaming its fields, and says something useful when it cannot.
 */
describe('Minecraft install script', () => {
  const template = SEED_TEMPLATES.find((t) => t.slug === 'minecraft-java');
  let server: Server;
  let port: number;
  let workDir: string;

  /** Field names deliberately unlike the ones the script was written against. */
  const builds = [
    { build: 12, downloads: { primaryDownload: { url: '/dl/paper-12.jar' } } },
    { build: 40, downloads: { primaryDownload: { url: '/dl/paper-40.jar' } } },
    { build: 7, downloads: { primaryDownload: { url: '/dl/paper-7.jar' } } },
  ];

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'storm-template-'));

    server = createServer((request, response) => {
      const url = request.url ?? '';
      const json = (body: unknown, code = 200) => {
        response.writeHead(code, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (url === '/v2/purpur') return json({ versions: ['1.20.6', '1.21.8'] });
      if (/^\/v2\/purpur\/[^/]+$/.test(url)) return json({ builds: { latest: '2431' } });
      if (url === '/v3/projects/paper') {
        return json({ versions: [{ version: '1.21.7' }, { version: '1.21.8' }] });
      }
      if (/^\/v3\/projects\/paper\/versions\/[^/]+\/builds$/.test(url)) {
        return json(
          builds.map((b) => ({
            ...b,
            downloads: {
              primaryDownload: {
                url: `http://127.0.0.1:${port}${b.downloads.primaryDownload.url}`,
              },
            },
          })),
        );
      }
      if (url.startsWith('/v3/projects/retired')) {
        response.writeHead(410);
        return response.end('Gone');
      }
      if (url.endsWith('/download') || url.startsWith('/dl/')) {
        response.writeHead(200);
        return response.end('jar');
      }
      response.writeHead(404);
      response.end('no');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  /** Runs the real script with the upstream hosts pointed at the stand-in. */
  async function install(env: Record<string, string>): Promise<{
    code: number;
    output: string;
    dir: string;
  }> {
    assert.ok(template, 'the minecraft-java template is missing');
    const dir = await mkdtemp(path.join(workDir, 'run-'));
    const script = template.installScript
      .replace(/https:\/\/api\.purpurmc\.org/g, `http://127.0.0.1:${port}`)
      .replace(/https:\/\/fill\.papermc\.io/g, `http://127.0.0.1:${port}`)
      .replace(/^apt-get .*$/m, 'true')
      .replace('mkdir -p /mnt/server && cd /mnt/server', `cd ${dir}`);

    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', script], { env: { ...process.env, ...env } });
      let output = '';
      child.stdout.on('data', (c) => (output += c));
      child.stderr.on('data', (c) => (output += c));
      child.on('close', (code) => resolve({ code: code ?? -1, output, dir }));
    });
  }

  it('resolves purpur through the Purpur API, not PaperMC', async () => {
    const { code, output, dir } = await install({ PROJECT: 'purpur', MINECRAFT_VERSION: 'latest' });
    assert.equal(code, 0, output);
    // Purpur was never a PaperMC project; asking there 404s, and once v2 was
    // retired it 410'd instead, which is how this surfaced.
    assert.doesNotMatch(output, /papermc/i);
    assert.match(output, /\/v2\/purpur\/1\.21\.8\/2431\/download/);
    assert.equal(await readFile(path.join(dir, 'server.jar'), 'utf8'), 'jar');
  });

  it('takes the newest paper build, not the first the API happens to list', async () => {
    const { code, output } = await install({ PROJECT: 'paper', MINECRAFT_VERSION: 'latest' });
    assert.equal(code, 0, output);
    assert.match(output, /paper-40\.jar/);
    assert.doesNotMatch(output, /paper-(7|12)\.jar/);
  });

  it('still finds the download when the API renames its fields', async () => {
    // The stand-in answers with `build` and `primaryDownload`, which is not
    // what the script was written against. Reading the shape loosely is what
    // keeps an upstream rename from breaking every install at once.
    const { code, output } = await install({ PROJECT: 'paper', MINECRAFT_VERSION: '1.21.8' });
    assert.equal(code, 0, output);
    assert.match(output, /paper-40\.jar/);
  });

  it('names the URL and the status when an API has moved', async () => {
    const { code, output } = await install({ PROJECT: 'retired', MINECRAFT_VERSION: '1.21.8' });
    assert.notEqual(code, 0);
    assert.match(output, /Request failed: http:\/\/127\.0\.0\.1:\d+\/v3\/projects\/retired/);
    assert.match(output, /HTTP 410/);
    // Not "000000": curl prints 000 itself when it never connected.
    assert.doesNotMatch(output, /HTTP \d{4,}/);
    assert.match(output, /SERVER_DOWNLOAD_URL/);
  });

  it('installs from a direct URL when one is set, without asking any API', async () => {
    const { code, output, dir } = await install({
      PROJECT: 'paper',
      SERVER_DOWNLOAD_URL: `http://127.0.0.1:${port}/dl/manual.jar`,
    });
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /Resolving/);
    assert.equal(await readFile(path.join(dir, 'server.jar'), 'utf8'), 'jar');
  });

  it('writes the files a Minecraft server needs to start', async () => {
    const { dir } = await install({ PROJECT: 'paper', MINECRAFT_VERSION: '1.21.8' });
    assert.match(await readFile(path.join(dir, 'eula.txt'), 'utf8'), /eula=true/);
    assert.match(await readFile(path.join(dir, 'server.properties'), 'utf8'), /server-port=/);
  });
});

describe('every template', () => {
  it('offers an image its default is actually one of', () => {
    // A default outside the declared set is an image the panel will not let
    // anyone switch back to once they leave it — the API only accepts declared
    // ones.
    for (const template of SEED_TEMPLATES) {
      assert.ok(
        Object.values(template.dockerImages).includes(template.defaultImage),
        `${template.slug} defaults to ${template.defaultImage}, which it does not declare`,
      );
    }
  });

  it('declares more than one image where the runtime version matters', () => {
    // Minecraft raises its minimum Java with the game version and refuses to
    // start on anything older, so a single image means a server that cannot be
    // fixed from the panel.
    const minecraft = SEED_TEMPLATES.find((t) => t.slug === 'minecraft-java');
    assert.ok(minecraft);
    const images = Object.values(minecraft.dockerImages);
    assert.ok(images.length > 1, 'only one Java version on offer');
    assert.ok(
      images.some((image) => /temurin:2[5-9]/.test(image)),
      `nothing newer than Java 24 on offer: ${images.join(', ')}`,
    );
  });

  it('has no retired PaperMC v2 URL left in it', () => {
    for (const template of SEED_TEMPLATES) {
      assert.doesNotMatch(
        template.installScript,
        /api\.papermc\.io\/v2/,
        `${template.slug} still calls the PaperMC v2 API, which answers 410`,
      );
    }
  });
});
