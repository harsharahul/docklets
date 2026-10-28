import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEPLOYER = new URL('../bin/deployer.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-backoff-'));
  fs.mkdirSync(path.join(root, 'my-app'));
  fs.writeFileSync(path.join(root, 'my-app', 'app.json'),
    JSON.stringify({ runtime: 'node', entry: 'server.js', port: 3000 }));
  fs.writeFileSync(path.join(root, 'my-app', 'server.js'), '// app');
  return root;
}

// A fake docker on PATH that logs each subcommand. `failing` names the
// subcommands that fail with `message` on stderr; `*` fails all of them until
// the `up` file exists.
function makeFakeDocker(failing, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fakebin-'));
  const calls = path.join(dir, 'calls');
  const up = path.join(dir, 'up');
  fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh
echo "$1" >> ${JSON.stringify(calls)}
[ -f ${JSON.stringify(up)} ] && exit 0
case "$1" in ${failing}) echo ${JSON.stringify(message)} >&2; exit 1 ;; esac
exit 0
`, { mode: 0o755 });
  return { dir, up, count: (cmd) => (fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').split('\n').filter((l) => l === cmd).length : 0) };
}

function startDeployer(root, fakeBin) {
  const proc = spawn(process.execPath, [DEPLOYER], {
    env: { ...process.env, DOCKLETS_ROOT: root, DOCKLETS_POLL_MS: '50',
      DOCKLETS_MAX_BACKOFF_MS: '400', PATH: `${fakeBin}:${process.env.PATH}` },
  });
  const io = { out: '', err: '' };
  proc.stdout.on('data', (d) => { io.out += d; });
  proc.stderr.on('data', (d) => { io.err += d; });
  return { proc, io };
}

const errorLines = (out) => out.split('\n').filter((l) => l.includes('converge error'));

test('an unreachable docker backs off, logs only changes, and logs recovery once', async () => {
  const docker = makeFakeDocker('*',
    'Cannot connect to the Docker daemon at unix:///fake/docker.sock. Is the docker daemon running?');
  const { proc, io } = startDeployer(makeRoot(), docker.dir);
  await sleep(2500);
  const passesWhileDown = docker.count('ps');
  fs.writeFileSync(docker.up, '');
  await sleep(1200);
  proc.kill();
  await once(proc, 'exit');

  // A fixed 50 ms loop makes about 50 passes in 2.5 s; waits of 50, 100, 200
  // and then 400 ms make about 9.
  assert.ok(passesWhileDown >= 4 && passesWhileDown <= 12, `passes while down: ${passesWhileDown}`);
  const errors = errorLines(io.out);
  assert.equal(errors.length, 4, io.out); // one line per wait: 50ms, 100ms, 200ms, 400ms
  assert.match(errors[0], /Cannot connect to the Docker daemon.*next pass in 50ms$/);
  assert.match(errors[3], /next pass in 400ms$/);
  assert.doesNotMatch(io.err, /Cannot connect/, 'docker CLI stderr leaked into the error log');
  assert.match(io.out, /converge recovered after \d+ failed passes/);
  assert.match(io.out, /started docklet-my-app/);
});

test('an app that fails to start keeps the normal interval and is logged once', async () => {
  const docker = makeFakeDocker('run', 'Unable to find image node:20-alpine locally');
  const { proc, io } = startDeployer(makeRoot(), docker.dir);
  await sleep(1200);
  proc.kill();
  await once(proc, 'exit');

  assert.ok(docker.count('run') >= 8, `start attempts: ${docker.count('run')}`);
  const errors = errorLines(io.out);
  assert.equal(errors.length, 1, io.out);
  assert.match(errors[0], /Unable to find image node:20-alpine locally; next pass in 50ms$/);
});
