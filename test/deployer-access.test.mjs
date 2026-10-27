import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPLOYER = new URL('../bin/deployer.mjs', import.meta.url).pathname;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-acc-'));
  const put = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  put('my-app/app.json', JSON.stringify({ runtime: 'node', entry: 'server.js', port: 3000 }));
  put('my-app/server.js', '// app');
  put('my-site/index.html', '<h1>hi</h1>');
  put('my-draft/index.html', '<h1>draft</h1>');
  put('my-draft/access.json', '{"v":1}');
  put('priv-app/app.json', JSON.stringify({ runtime: 'node', entry: 'server.js', port: 3000 }));
  put('priv-app/server.js', '// private app');
  put('priv-app/access.json', '{"v":1}');
  return root;
}

// A fake docker on PATH that logs every invocation, one line per call.
function makeFakeDocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fakebin-'));
  const logFile = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\nexit 0\n`, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []), reset: () => fs.rmSync(logFile, { force: true }) };
}

const runOnce = (root, fake, env = {}) => spawnSync(process.execPath, [DEPLOYER, '--once'], {
  encoding: 'utf8', env: { ...process.env, DOCKLETS_ROOT: root, PATH: `${fake.dir}:${process.env.PATH}`, ...env },
});

test('the public status feed leaves private slugs out', () => {
  const root = makeRoot();
  const r = runOnce(root, makeFakeDocker(), { DOCKLETS_DRIVER: 'none' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(path.join(root, '.status.json'), 'utf8'));
  assert.deepEqual(s.apps.map((a) => a.slug), ['my-app']);
  assert.deepEqual(s.static, ['my-site']);
});

test('changing a private app\'s access never restarts it', () => {
  const root = makeRoot();
  const fake = makeFakeDocker();
  runOnce(root, fake);
  const hashOf = () => fake.calls().find((c) => c.startsWith('run -d --name docklet-priv-app '))?.match(/docklet-hash=(\w+)/)?.[1];
  const before = hashOf();
  assert.ok(before);
  fake.reset();
  fs.writeFileSync(path.join(root, 'priv-app', 'access.json'), '{"v":1,"links":[]}');
  runOnce(root, fake);
  assert.equal(hashOf(), before);
});
