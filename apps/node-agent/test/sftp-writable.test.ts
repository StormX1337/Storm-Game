import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ssh2 from 'ssh2';
import { openModeFor } from '../src/services/sftp.service.js';

const { OPEN_MODE } = ssh2.utils.sftp;

/**
 * Whether an SFTP session may add bytes.
 *
 * The disk limit is a promise the panel makes and the file manager keeps: an
 * upload from a server that is over its limit is refused. SFTP reaches the
 * same files through a different door, and it never asked — so the customer
 * who could not drag a modpack in through the browser dragged it in over SFTP
 * instead. The panel now answers this at login and the agent honours it.
 *
 * Read-only rather than closed. Being over a limit has to be a state somebody
 * can get themselves out of, so reading, listing, deleting and renaming all
 * carry on working.
 */
describe('what an SFTP session may open a file for', () => {
  it('opens anything for reading, limit or no limit', () => {
    assert.equal(openModeFor(OPEN_MODE.READ, true), 'r');
    assert.equal(openModeFor(OPEN_MODE.READ, false), 'r');
  });

  it('opens a file for writing while there is room', () => {
    assert.equal(openModeFor(OPEN_MODE.WRITE, true), 'w');
    assert.equal(openModeFor(OPEN_MODE.WRITE | OPEN_MODE.CREAT, true), 'w');
    assert.equal(openModeFor(OPEN_MODE.WRITE | OPEN_MODE.APPEND, true), 'a');
    assert.equal(openModeFor(OPEN_MODE.READ | OPEN_MODE.WRITE, true), 'r+');
  });

  it('refuses every way of adding bytes once the server is over', () => {
    // Each of these is a real client doing an ordinary upload: a plain put, a
    // resumed one, and an editor writing in place.
    assert.equal(openModeFor(OPEN_MODE.WRITE, false), null);
    assert.equal(openModeFor(OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC, false), null);
    assert.equal(openModeFor(OPEN_MODE.WRITE | OPEN_MODE.APPEND, false), null);
    assert.equal(openModeFor(OPEN_MODE.READ | OPEN_MODE.WRITE, false), null);
  });

  it('does not let a read flag smuggle a write past', () => {
    // read+write is how an editor opens a file, and it writes through it. It
    // has to be refused, or the whole check is one flag away from nothing.
    assert.equal(openModeFor(OPEN_MODE.READ | OPEN_MODE.WRITE | OPEN_MODE.CREAT, false), null);
  });
});
