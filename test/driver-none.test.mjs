import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPLOYER = new URL('../bin/deployer.mjs', import.meta.url).pathname;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-none-'));
  fs.mkdirSync(path.join(root, 'my-app'));
  fs.writeFileSync(path.join(root, 'my-app', 'app.json'),
    JSON.stringify({ runtime: 'node', entry: 'server.js', port: 3000 }));
  fs.writeFileSync(path.join(root, 'my-app', 'server.js'), '// app');
  fs.mkdirSync(path.join(root, 'my-site'));
  fs.writeFileSync(path.join(root, 'my-site', 'index.html'), '<h1>hi</h1>');
  return root;
}

// A fake docker on PATH records any invocation; driver=none must never call it.
function makeFakeDocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fakebin-'));
  const marker = path.join(dir, 'docker-was-called');
  fs.writeFileSync(path.join(dir, 'docker'),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`, { mode: 0o755 });
  return { dir, marker };
}

function runOnce(root, extraEnv, fakeBin) {
  return spawnSync(process.execPath, [DEPLOYER, '--once'], {
    encoding: 'utf8',
    env: { ...process.env, DOCKLETS_ROOT: root, PATH: `${fakeBin}:${process.env.PATH}`, ...extraEnv },
  });
}

test('driver=none writes a pending status feed and never touches docker', () => {
  const root = makeRoot();
  const { dir, marker } = makeFakeDocker();
  const r = runOnce(root, { DOCKLETS_DRIVER: 'none' }, dir);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.status.json'), 'utf8'));
  assert.deepEqual(s.apps, [{ slug: 'my-app', state: 'pending' }]);
  assert.deepEqual(s.static, ['my-site']);
  assert.ok(!fs.existsSync(marker), 'docker was invoked under driver=none');
});

test('a fresh .sync-lock skips the converge pass entirely', () => {
  const root = makeRoot();
  const { dir, marker } = makeFakeDocker();
  fs.writeFileSync(path.join(root, '.sync-lock'), '');
  const r = runOnce(root, { DOCKLETS_DRIVER: 'none' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(root, '.status.json')), 'converge ran despite the lock');
  assert.ok(!fs.existsSync(marker));
});

test('a stale .sync-lock (old mtime) does not block converge', () => {
  const root = makeRoot();
  const { dir } = makeFakeDocker();
  const lock = path.join(root, '.sync-lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(lock, old, old);
  const r = runOnce(root, { DOCKLETS_DRIVER: 'none' }, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(root, '.status.json')));
});

test('an unknown driver is refused with exit 1', () => {
  const root = makeRoot();
  const { dir } = makeFakeDocker();
  const r = runOnce(root, { DOCKLETS_DRIVER: 'kubernetes' }, dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DOCKLETS_DRIVER/);
});
