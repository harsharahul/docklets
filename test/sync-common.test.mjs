import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validRelPath, walkManifest, hashFile, scryptHash, scryptVerify }
  from '../bin/sync-common.mjs';

test('validRelPath accepts normal paths and rejects escapes and reserved names', () => {
  assert.ok(validRelPath('index.html'));
  assert.ok(validRelPath('notes/deep/file.md'));
  assert.ok(validRelPath('hello-static/index.html'));
  assert.ok(validRelPath('My Notes/reading list.md'));
  for (const bad of ['', '/abs', 'a/../b', '..', './x', 'a/.hidden/x', '.env',
    'a\\b', 'a/', 'a//b', 'status/index.html', 'status', 'x'.repeat(1025),
    'a\tb', 'a\nb']) {
    assert.equal(validRelPath(bad), false, `accepted: ${JSON.stringify(bad)}`);
  }
});

test('walkManifest lists regular files, skips dot-entries, symlinks, and status', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-walk-'));
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'index.html'), 'hello');
  fs.writeFileSync(path.join(root, 'notes', 'a.md'), 'note a');
  fs.mkdirSync(path.join(root, '.gateway'));
  fs.writeFileSync(path.join(root, '.gateway', 'x'), 'x');
  fs.writeFileSync(path.join(root, '.status.json'), '{}');
  fs.mkdirSync(path.join(root, 'status'));
  fs.writeFileSync(path.join(root, 'status', 'index.html'), 'dash');
  fs.symlinkSync('/etc/hosts', path.join(root, 'link'));
  const m = await walkManifest(root);
  assert.deepEqual(m.map((f) => f.path), ['index.html', 'notes/a.md']);
  assert.equal(m[0].size, 5);
  assert.equal(m[0].sha256, await hashFile(path.join(root, 'index.html')));
});

test('scrypt hash round-trips and rejects a wrong token', () => {
  const h = scryptHash('tok-secret');
  assert.match(h, /^scrypt\$16384\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(scryptVerify('tok-secret', h));
  assert.equal(scryptVerify('tok-wrong', h), false);
  assert.equal(scryptVerify('tok-secret', 'garbage'), false);
});

test('scryptVerify accepts the hex hash encoding used by managed control planes', () => {
  // scrypt$N$salt$key with hex salt (32 chars) and hex key (64 chars),
  // N=16384 r=8 p=1 keylen 32: the format docklets.dev stores.
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('tok-hex', salt, 32, { N: 16384, r: 8, p: 1 });
  const hexStored = `scrypt$16384$${salt.toString('hex')}$${key.toString('hex')}`;
  assert.ok(scryptVerify('tok-hex', hexStored));
  assert.equal(scryptVerify('tok-wrong', hexStored), false);
  // b64url format still verifies (round trip through our own mint)
  assert.ok(scryptVerify('tok-b64', scryptHash('tok-b64')));
});
