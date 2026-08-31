import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseProvisioner } from '../src/services/database-provisioner.js';

/**
 * CREATE DATABASE and GRANT cannot take bound parameters in either engine, so
 * every identifier is interpolated into SQL and this pattern is the only thing
 * standing between the panel and injection on a shared database host — where
 * the blast radius is every other customer's data.
 */
describe('database identifiers', () => {
  const ok = (value: string) => DatabaseProvisioner.IDENTIFIER.test(value);

  it('accepts the names the panel actually generates', () => {
    assert.ok(ok('sphtfyqzk_world'));
    assert.ok(ok('s1a2b3c4_survival'));
    assert.ok(ok('a'));
    assert.ok(ok(`a${'b'.repeat(62)}`), '63 characters is the identifier limit');
  });

  it('refuses anything that could close a quote or start a statement', () => {
    for (const attempt of [
      'db"; DROP DATABASE other; --',
      'db`; GRANT ALL ON *.* TO evil@"%"; --',
      "db'; SELECT 1; --",
      'db; DROP DATABASE other',
      'db--comment',
      'db/*comment*/',
      'db name',
      'db\nname',
      'db\\name',
      'other"."table',
    ]) {
      assert.equal(ok(attempt), false, `accepted: ${attempt}`);
    }
  });

  it('refuses the empty string and anything overlong', () => {
    assert.equal(ok(''), false);
    assert.equal(ok('a'.repeat(64)), false, 'past what the engines accept');
  });

  it('refuses a name that does not start with a letter', () => {
    // A leading digit needs quoting in Postgres, and a leading underscore is
    // reserved by convention on both engines.
    assert.equal(ok('1db'), false);
    assert.equal(ok('_db'), false);
  });

  it('refuses non-ASCII, which the engines fold in ways that surprise', () => {
    assert.equal(ok('dbü'), false);
    assert.equal(ok('db '), false);
    // A homoglyph is a different identifier that reads the same to a person.
    assert.equal(ok('dаtabase'), false, 'Cyrillic a accepted as Latin a');
  });
});
