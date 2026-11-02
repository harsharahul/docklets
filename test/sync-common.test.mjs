import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validRelPath, walkManifest, hashFile, scryptHash, scryptVerify, scryptVerifyAsync, markWorkers, WORKER_MARK }
  from '../bin/sync-common.mjs';

test('validRelPath accepts normal paths and rejects escapes and reserved names', () => {
  assert.ok(validRelPath('index.html'));
  assert.ok(validRelPath('notes/deep/file.md'));
  assert.ok(validRelPath('hello-static/index.html'));
  assert.ok(validRelPath('My Notes/reading list.md'));
  for (const bad of ['', '/abs', 'a/../b', '..', './x', 'a/.hidden/x', '.env',
    'a\\b', 'a/', 'a//b', 'status/index.html', 'status', 'lost+found/x', 'x'.repeat(1025),
    'a\tb', 'a\nb']) {
    assert.equal(validRelPath(bad), false, `accepted: ${JSON.stringify(bad)}`);
  }
});

test('walkManifest lists regular files, skips dot-entries, symlinks, status, and lost+found', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-walk-'));
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'index.html'), 'hello');
  fs.writeFileSync(path.join(root, 'notes', 'a.md'), 'note a');
  fs.mkdirSync(path.join(root, '.gateway'));
  fs.writeFileSync(path.join(root, '.gateway', 'x'), 'x');
  fs.writeFileSync(path.join(root, '.status.json'), '{}');
  fs.mkdirSync(path.join(root, 'status'));
  fs.writeFileSync(path.join(root, 'status', 'index.html'), 'dash');
  fs.mkdirSync(path.join(root, 'lost+found'));
  fs.writeFileSync(path.join(root, 'lost+found', '#12'), 'orphan');
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

test('scryptVerifyAsync agrees with scryptVerify on both encodings and on garbage', async () => {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync('tok-hex', salt, 32, { N: 16384, r: 8, p: 1 });
  const hexStored = `scrypt$16384$${salt.toString('hex')}$${key.toString('hex')}`;
  assert.equal(await scryptVerifyAsync('tok-hex', hexStored), true);
  assert.equal(await scryptVerifyAsync('tok-wrong', hexStored), false);
  assert.equal(await scryptVerifyAsync('pw-b64', scryptHash('pw-b64')), true);
  assert.equal(await scryptVerifyAsync('pw-b64', 'garbage'), false);
  assert.equal(await scryptVerifyAsync('pw-b64', 'scrypt$99999999999$x$y'), false);
});

test('markWorkers marks worker slugs with a .worker file and clears stale marks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-mark-'));
  const slug = (name, files) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), c);
  };
  slug('api', { 'app.json': JSON.stringify({ runtime: 'worker', entry: 'worker.js' }), 'worker.js': '// w' });
  slug('site', { 'index.html': '<h1>hi</h1>' });
  slug('old', { 'app.json': JSON.stringify({ runtime: 'node', entry: 's.js', port: 3000 }), [WORKER_MARK]: '' });
  slug('gone', { [WORKER_MARK]: '' });
  slug('broken', { 'app.json': '{not json' });
  slug('Linked', { 'app.json': JSON.stringify({ runtime: 'worker', entry: 'w.js' }) });
  fs.symlinkSync(path.join(root, 'api'), path.join(root, 'alias'));
  slug('symlinked', {});
  fs.symlinkSync(path.join(root, 'api', 'app.json'), path.join(root, 'symlinked', 'app.json'));
  fs.writeFileSync(path.join(root, 'README.md'), 'not a slug');

  assert.deepEqual(markWorkers(root), ['api']);
  assert.ok(fs.existsSync(path.join(root, 'api', WORKER_MARK)), 'worker slug not marked');
  assert.equal(fs.existsSync(path.join(root, 'site', WORKER_MARK)), false, 'static slug marked');
  assert.equal(fs.existsSync(path.join(root, 'old', WORKER_MARK)), false, 'stale mark on a node app kept');
  assert.equal(fs.existsSync(path.join(root, 'gone', WORKER_MARK)), false, 'stale mark without a manifest kept');
  assert.equal(fs.existsSync(path.join(root, 'broken', WORKER_MARK)), false, 'invalid manifest marked');
  assert.equal(fs.existsSync(path.join(root, 'Linked', WORKER_MARK)), false, 'non-slug directory marked');
  assert.equal(fs.existsSync(path.join(root, 'symlinked', WORKER_MARK)), false, 'symlinked manifest marked');
  assert.equal(fs.lstatSync(path.join(root, 'alias')).isSymbolicLink(), true);
  assert.equal(fs.readdirSync(path.join(root, 'alias')).includes(WORKER_MARK), true, 'the real dir behind the symlink is the one marked');

  // Idempotent and stable: a second pass changes nothing and keeps the mark.
  const before = fs.statSync(path.join(root, 'api', WORKER_MARK)).mtimeMs;
  assert.deepEqual(markWorkers(root), ['api']);
  assert.equal(fs.statSync(path.join(root, 'api', WORKER_MARK)).mtimeMs, before);

  // The manifest changing away from worker removes the mark on the next pass.
  fs.writeFileSync(path.join(root, 'api', 'app.json'), JSON.stringify({ runtime: 'node', entry: 'worker.js', port: 3000 }));
  assert.deepEqual(markWorkers(root), []);
  assert.equal(fs.existsSync(path.join(root, 'api', WORKER_MARK)), false);
});
