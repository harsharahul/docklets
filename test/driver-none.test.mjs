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
  fs.mkdirSync(path.join(root, 'my-worker'));
  fs.writeFileSync(path.join(root, 'my-worker', 'app.json'),
    JSON.stringify({ runtime: 'worker', entry: 'worker.js', env: { GREETING: 'hi' } }));
  fs.writeFileSync(path.join(root, 'my-worker', 'worker.js'), '// worker');
  return root;
}

// A fake docker on PATH records any invocation (and its arguments);
// driver=none must never call it.
function makeFakeDocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fakebin-'));
  const marker = path.join(dir, 'docker-was-called');
  const log = path.join(dir, 'docker-args.log');
  fs.writeFileSync(path.join(dir, 'docker'),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  return { dir, marker, log };
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
  assert.deepEqual(s.apps, [{ slug: 'my-app', state: 'pending' }, { slug: 'my-worker', state: 'pending' }]);
  assert.deepEqual(s.static, ['my-site']);
  assert.ok(!fs.existsSync(marker), 'docker was invoked under driver=none');
});

test('a worker manifest needs an entry but no port', () => {
  const root = makeRoot();
  const { dir } = makeFakeDocker();
  fs.writeFileSync(path.join(root, 'my-worker', 'app.json'), JSON.stringify({ runtime: 'worker' }));
  let r = runOnce(root, { DOCKLETS_DRIVER: 'none' }, dir);
  assert.equal(r.status, 0, r.stderr);
  let s = JSON.parse(fs.readFileSync(path.join(root, '.status.json'), 'utf8'));
  assert.ok(!s.apps.some((a) => a.slug === 'my-worker'), 'a worker without an entry was accepted');
  assert.match(r.stdout, /SKIP my-worker: bad entry/);
  fs.writeFileSync(path.join(root, 'my-worker', 'app.json'), JSON.stringify({ runtime: 'worker', entry: '../x.js' }));
  r = runOnce(root, { DOCKLETS_DRIVER: 'none' }, dir);
  s = JSON.parse(fs.readFileSync(path.join(root, '.status.json'), 'utf8'));
  assert.ok(!s.apps.some((a) => a.slug === 'my-worker'), 'a worker with an escaping entry was accepted');
});

test('driver=docker never runs a worker slug as a container and writes it no route', () => {
  const root = makeRoot();
  const { dir, log } = makeFakeDocker();
  const r = runOnce(root, { DOCKLETS_DRIVER: 'docker', DOCKLETS_GATEWAY: 'gw', DOCKLETS_PREFIX: 'dk-t-' }, dir);
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /run .*dk-t-my-app/, 'the node app was not started');
  assert.doesNotMatch(calls, /dk-t-my-worker/, 'the worker slug was handed to docker');
  assert.ok(fs.existsSync(path.join(root, '.gateway', 'routes', 'my-app.caddy')));
  assert.ok(!fs.existsSync(path.join(root, '.gateway', 'routes', 'my-worker.caddy')), 'a route fragment was written for a worker slug');
  const s = JSON.parse(fs.readFileSync(path.join(root, '.status.json'), 'utf8'));
  assert.deepEqual(s.apps.find((a) => a.slug === 'my-worker'), { slug: 'my-worker', state: 'pending' });
  assert.match(r.stdout, /my-worker: worker runtime .*hosted/);
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
