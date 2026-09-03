import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '@storm/security';
import { convertEgg, isPterodactylEgg, slugify, translateRules } from '../src/services/egg.js';
import { validateAgainstRules } from '../src/services/server.service.js';
import { createTestApp, deleteUser, registerUser, uniqueSuffix } from './helpers.js';
import type { RegisteredUser } from './helpers.js';

/**
 * Bringing a Pterodactyl egg across.
 *
 * Every game that has ever been hosted has an egg for it, written by somebody
 * who already solved its install script, and an operator moving here arrives
 * with a folder full of them. The two formats are close relatives, so most of
 * the crossing is renaming — and the parts that are not renaming are exactly
 * what these pin down, because an egg that arrives subtly wrong is worse than
 * one that was refused: it fails later, on somebody's server.
 */

/** A Paper egg, in the shape the real ones are passed around in. */
const PAPER_EGG = {
  _comment: 'DO NOT EDIT: FILE GENERATED AUTOMATICALLY BY PTERODACTYL PANEL',
  meta: { version: 'PTDL_v2', update_url: null },
  exported_at: '2026-01-01T00:00:00+00:00',
  name: 'Paper',
  author: 'support@pterodactyl.io',
  description: 'High performance Minecraft server built on the Spigot API.',
  features: ['eula', 'java_version', 'pid_limit'],
  docker_images: {
    'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
    'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
  },
  file_denylist: [],
  startup: 'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}}',
  config: {
    files: JSON.stringify({
      'server.properties': {
        parser: 'properties',
        find: {
          'server-ip': '0.0.0.0',
          'server-port': '{{server.build.default.port}}',
          'query.port': '{{server.build.default.port}}',
        },
      },
    }),
    startup: JSON.stringify({ done: ')! For help, type ' }),
    logs: JSON.stringify({ custom: false, location: 'logs/latest.log' }),
    stop: 'stop',
  },
  scripts: {
    installation: {
      script: '#!/bin/bash\ncurl -o server.jar https://example.invalid/paper.jar\n',
      container: 'ghcr.io/pterodactyl/installers:debian',
      entrypoint: 'bash',
    },
  },
  variables: [
    {
      name: 'Server Jar File',
      description: 'The name of the jar file to run.',
      env_variable: 'SERVER_JARFILE',
      default_value: 'server.jar',
      user_viewable: true,
      user_editable: true,
      rules: 'required|regex:/^([\\w\\d._-]+)(\\.jar)$/',
      field_type: 'text',
    },
    {
      name: 'Minecraft Version',
      description: 'The version to install.',
      env_variable: 'MINECRAFT_VERSION',
      default_value: 'latest',
      user_viewable: true,
      user_editable: true,
      rules: 'required|string|max:20',
      field_type: 'text',
    },
  ],
};

describe('reading a Pterodactyl egg', () => {
  it('knows an egg from one of this panel’s own exports', () => {
    assert.equal(isPterodactylEgg(PAPER_EGG), true);

    // Plenty of eggs in circulation have had their meta block edited out, so
    // the shape has to decide it rather than a version string alone.
    const { meta: _meta, ...withoutMeta } = PAPER_EGG;
    assert.equal(isPterodactylEgg(withoutMeta), true);

    assert.equal(isPterodactylEgg({ _format: 'storm-template/v1', name: 'Paper' }), false);
    assert.equal(isPterodactylEgg(null), false);
    assert.equal(isPterodactylEgg([PAPER_EGG]), false);
    assert.equal(isPterodactylEgg('an egg'), false);
  });

  it('carries across the parts that only need renaming', () => {
    const { template } = convertEgg(PAPER_EGG);

    assert.equal(template.name, 'Paper');
    assert.equal(template.slug, 'paper');
    assert.equal(template.author, 'support@pterodactyl.io');
    assert.deepEqual(template.dockerImages, {
      'Java 21': 'ghcr.io/pterodactyl/yolks:java_21',
      'Java 17': 'ghcr.io/pterodactyl/yolks:java_17',
    });
    assert.equal(template.defaultImage, 'ghcr.io/pterodactyl/yolks:java_21');
    assert.equal(template.stopCommand, 'stop');
    assert.equal(template.installContainer, 'ghcr.io/pterodactyl/installers:debian');
    assert.equal(template.installEntrypoint, 'bash');
    assert.match(template.installScript, /curl -o server\.jar/);
    assert.equal(template.startupDetection, ')! For help, type ');
    assert.deepEqual(template.logConfig, { custom: false, location: 'logs/latest.log' });
  });

  it('rewrites the placeholders that are spelled differently here', () => {
    // {{server.build.default.port}} is what an egg writes; this panel resolves
    // server.allocation.port and would otherwise write the literal braces into
    // the customer's server.properties.
    const { template } = convertEgg(PAPER_EGG);
    const properties = (template.configFiles as Record<string, { find: Record<string, string> }>)[
      'server.properties'
    ];

    assert.ok(properties, 'the config file was not carried over');
    assert.equal(properties.find['server-port'], '{{server.allocation.port}}');
    assert.equal(properties.find['query.port'], '{{server.allocation.port}}');
    assert.equal(properties.find['server-ip'], '0.0.0.0');

    // The startup line already speaks a dialect both panels share.
    assert.equal(
      template.startupCommand,
      'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar {{SERVER_JARFILE}}',
    );
  });

  it('makes an egg’s PHP regex into one this panel can actually run', () => {
    // The difference that would have made every import look fine and then
    // refuse every value: an egg wraps its pattern in delimiters, and this
    // panel hands the argument straight to RegExp, where a leading slash is a
    // character to match.
    const { template } = convertEgg(PAPER_EGG);
    const jar = template.variables.find((entry) => entry.envVariable === 'SERVER_JARFILE');
    assert.ok(jar);

    assert.equal(jar.rules, 'required|regex:^([\\w\\d._-]+)(\\.jar)$');
    assert.equal(validateAgainstRules('server.jar', jar.rules), null);
    assert.ok(validateAgainstRules('server.zip', jar.rules), 'the pattern stopped checking');
  });

  it('says so when a pattern cannot survive the crossing', () => {
    // Rules are split on "|", so an alternation is torn in half by the parser
    // and there is nothing to be done about it here. The variable keeps its
    // other checks and the operator is told which one to re-add.
    const warnings: string[] = [];
    const rules = translateRules('required|regex:/^(paper|purpur)$/|max:10', 'PROJECT', warnings);

    assert.equal(rules, 'required|max:10');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /PROJECT/);
    assert.equal(validateAgainstRules('paper', rules), null);
  });

  it('keeps the rules it can and never leaves a variable ruleless', () => {
    const warnings: string[] = [];
    assert.equal(translateRules('required|string|max:20', 'V', warnings), 'required|string|max:20');
    assert.equal(translateRules('', 'V', warnings), 'string');
    assert.equal(translateRules('regex:/^x$/', 'V', warnings), 'regex:^x$');
    // Already bare, as a Storm template would write it.
    assert.equal(translateRules('regex:^x$', 'V', warnings), 'regex:^x$');
    assert.deepEqual(warnings, []);
  });

  it('reads the older shapes still in circulation', () => {
    const older = {
      ...PAPER_EGG,
      meta: { version: 'PTDL_v1' },
      docker_images: undefined,
      images: ['quay.io/pterodactyl/core:java'],
      config: { ...PAPER_EGG.config, files: { 'x.yml': { parser: 'yaml', find: { a: 'b' } } } },
      variables: [
        {
          name: 'Old',
          env_variable: 'OLD_VAR',
          default_value: '1',
          // v1 wrote these as the strings "1" and "0".
          user_viewable: '1',
          user_editable: '0',
          rules: 'required|string',
        },
      ],
    };

    const { template } = convertEgg(older);
    assert.deepEqual(template.dockerImages, { 'core java': 'quay.io/pterodactyl/core:java' });
    assert.equal(template.defaultImage, 'quay.io/pterodactyl/core:java');
    assert.equal(template.variables[0]?.userViewable, true);
    assert.equal(template.variables[0]?.userEditable, false);
  });

  it('reports a config file it cannot write instead of pretending', () => {
    const withXml = {
      ...PAPER_EGG,
      config: {
        ...PAPER_EGG.config,
        files: JSON.stringify({
          'config.xml': { parser: 'xml', find: { 'a.b': 'c' } },
          'server.properties': { parser: 'properties', find: { 'server-port': '25565' } },
        }),
      },
    };

    const { template, warnings } = convertEgg(withXml);
    const files = template.configFiles as Record<string, unknown>;

    assert.ok(!('config.xml' in files), 'kept a file it cannot write');
    assert.ok('server.properties' in files, 'dropped one it can');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /config\.xml/);
    assert.match(warnings[0] ?? '', /xml/);
  });

  it('does not turn on this panel’s own features because an egg listed some', () => {
    // An egg's "features" are Pterodactyl's install helpers — eula,
    // java_version. This panel's are its optional pages, and matching them by
    // name would give a plugin manager to a game with no plugins.
    const { template } = convertEgg(PAPER_EGG);
    assert.deepEqual(template.features, []);
  });

  it('refuses an egg that could never run', () => {
    for (const [broken, expected] of [
      [{ ...PAPER_EGG, name: '' }, /name/i],
      [{ ...PAPER_EGG, startup: '' }, /startup/i],
      [{ ...PAPER_EGG, docker_images: {}, images: [], image: '' }, /image/i],
    ] as const) {
      assert.throws(() => convertEgg(broken), expected);
    }
    assert.throws(() => convertEgg('not an egg'), /not an egg/i);
  });

  it('skips a variable the panel could not key an environment on', () => {
    const messy = {
      ...PAPER_EGG,
      variables: [
        { name: 'Fine', env_variable: 'FINE', rules: 'string' },
        { name: 'Dashes', env_variable: 'not-valid', rules: 'string' },
        { name: 'Twice', env_variable: 'FINE', rules: 'string' },
      ],
    };

    const { template, warnings } = convertEgg(messy);
    assert.deepEqual(
      template.variables.map((entry) => entry.envVariable),
      ['FINE'],
    );
    assert.equal(warnings.length, 2, JSON.stringify(warnings));
  });

  it('makes a slug out of a name, since an egg has none', () => {
    assert.equal(slugify('Paper'), 'paper');
    assert.equal(slugify('Counter-Strike 2'), 'counter-strike-2');
    assert.equal(slugify("Garry's Mod"), 'garry-s-mod');
    assert.equal(slugify('!!!'), 'imported-template');
    assert.match(slugify('a'.repeat(200)), /^a{1,100}$/);
  });
});

/**
 * The same thing through the endpoint an operator actually uses.
 */
describe('importing a template', () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let customer: RegisteredUser;
  const createdUsers: string[] = [];
  const createdTemplates: string[] = [];

  const admin = () => ({ authorization: `Bearer ${adminToken}` });

  async function importEgg(payload: unknown) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/templates/import',
      headers: admin(),
      payload: payload as Record<string, unknown>,
    });
    if (response.statusCode === 201) {
      createdTemplates.push(response.json<{ data: { id: string } }>().data.id);
    }
    return response;
  }

  before(async () => {
    const context = await createTestApp();
    app = context.app;
    cleanup = context.cleanup;

    customer = await registerUser(app);
    createdUsers.push(customer.id);

    const suffix = uniqueSuffix();
    const ownerRole = await app.prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const owner = await app.prisma.user.create({
      data: {
        email: `egg-owner-${suffix}@storm.test`,
        username: `eggowner${suffix}`,
        passwordHash: await hashPassword('OwnerPassword123!'),
        roleId: ownerRole.id,
        emailVerifiedAt: new Date(),
      },
    });
    createdUsers.push(owner.id);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: owner.email, password: 'OwnerPassword123!' },
    });
    adminToken = login.json<{ data: { accessToken: string } }>().data.accessToken;
  });

  after(async () => {
    for (const id of createdTemplates) {
      await app.prisma.gameTemplate.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of createdUsers) await deleteUser(app, id);
    await cleanup();
  });

  it('takes an egg straight from the folder it arrived in', async () => {
    const slug = `paper-${uniqueSuffix().slice(0, 6)}`;
    const response = await importEgg({
      ...PAPER_EGG,
      slug,
      game: 'Minecraft',
      category: 'Sandbox',
    });
    assert.equal(response.statusCode, 201, response.body);

    const created = response.json<{
      data: { id: string; slug: string; game: string; warnings: string[] };
    }>().data;
    assert.equal(created.slug, slug);
    assert.equal(created.game, 'Minecraft');
    assert.deepEqual(created.warnings, [], JSON.stringify(created.warnings));

    const stored = await app.prisma.gameTemplate.findUniqueOrThrow({
      where: { id: created.id },
      include: { variables: { orderBy: { sortOrder: 'asc' } } },
    });
    assert.equal(stored.variables.length, 2);
    assert.equal(stored.variables[0]?.envVariable, 'SERVER_JARFILE');
    assert.equal(stored.category, 'Sandbox');
  });

  it('still takes this panel’s own export', async () => {
    const slug = `storm-export-${uniqueSuffix().slice(0, 6)}`;
    const response = await importEgg({
      _format: 'storm-template/v1',
      name: 'Storm Export',
      slug,
      game: 'Test',
      dockerImages: { Only: 'alpine:3' },
      defaultImage: 'alpine:3',
      startupCommand: './run',
      variables: [],
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json<{ data: { slug: string } }>().data.slug, slug);
  });

  it('finds the egg a free slug rather than stopping on a name clash', async () => {
    // An operator importing thirty eggs did not choose the name that clashed.
    const first = await importEgg(PAPER_EGG);
    assert.equal(first.statusCode, 201, first.body);
    const second = await importEgg(PAPER_EGG);
    assert.equal(second.statusCode, 201, second.body);

    const a = first.json<{ data: { slug: string } }>().data.slug;
    const b = second.json<{ data: { slug: string; warnings: string[] } }>().data;
    assert.notEqual(a, b.slug);
    assert.match(b.slug, new RegExp(`^${a}-\\d+$`));
    assert.ok(
      b.warnings.some((warning) => warning.includes(b.slug)),
      'renamed it without saying so',
    );
  });

  it('refuses a slug the operator typed themselves when it is taken', async () => {
    // Their own slug is theirs; a clash there is a real answer rather than a
    // number silently stapled on.
    const slug = `mine-${uniqueSuffix().slice(0, 6)}`;
    assert.equal((await importEgg({ ...PAPER_EGG, slug })).statusCode, 201);

    const again = await importEgg({ ...PAPER_EGG, slug });
    assert.equal(again.statusCode, 409, again.body);
  });

  it('says what it could not carry, in the same answer', async () => {
    const awkward = {
      ...PAPER_EGG,
      config: {
        ...PAPER_EGG.config,
        files: JSON.stringify({ 'a.xml': { parser: 'xml', find: { a: 'b' } } }),
      },
    };

    const response = await importEgg(awkward);
    assert.equal(response.statusCode, 201, response.body);
    const warnings = response.json<{ data: { warnings: string[] } }>().data.warnings;
    assert.ok(
      warnings.some((warning) => warning.includes('a.xml')),
      JSON.stringify(warnings),
    );
  });

  it('refuses a broken egg with the reason, not a schema dump', async () => {
    const response = await importEgg({ ...PAPER_EGG, startup: '' });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.body, /startup/i);
  });

  it('is closed to an account without templates.manage', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/templates/import',
      headers: { authorization: `Bearer ${customer.accessToken}` },
      payload: PAPER_EGG,
    });
    assert.equal(response.statusCode, 403, response.body);
  });
});
