import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UPDATE = new URL('../install/update.sh', import.meta.url).pathname;
const exec = promisify(execFile);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

// A docklets remote with three releases and a release candidate, an install
// cloned at v0.4.0, a home with the install settings, and an installer
// stand-in that records which version it was run from.
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-update-'));
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'install'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  const release = (version, tag) => {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'docklets', version }, null, 2) + '\n');
    fs.copyFileSync(UPDATE, path.join(work, 'install', 'update.sh'));
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', `release ${version}`);
    git(work, 'tag', tag);
  };
  release('0.3.0', 'v0.3.0');
  release('0.4.0', 'v0.4.0');
  release('0.5.0', 'v0.5.0');
  release('0.6.0-rc.1', 'v0.6.0-rc.1');
  const remote = path.join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  const src = path.join(dir, 'src');
  git(dir, 'clone', '-q', '--depth', '1', '--branch', 'v0.4.0', `file://${remote}`, src);

  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'docklets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'docklets', 'install.env'),
    `DOCKLETS_ROOT=${path.join(dir, 'root')}\nDOCKLETS_PORT=18089\nDOCKLETS_AUTO_UPDATE=1\n`);
  const calls = path.join(dir, 'installer-calls');
  const installer = path.join(dir, 'installer.sh');
  fs.writeFileSync(installer,
    '#!/bin/bash\nv=$(sed -n \'s/.*"version": "\\(.*\\)".*/\\1/p\' package.json)\n' +
    `echo "$v $1 $2 \${DOCKLETS_AUTO_UPDATE:-}" >> '${calls}'\n`, { mode: 0o755 });
  const versionOf = () => JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
  const installs = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []);
  return { dir, src, home, installer, versionOf, installs };
}

// The gateway stand-in: answers with whatever status the test sets.
async function gateway(status) {
  const server = createServer((req, res) => { res.writeHead(status.code); res.end(); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

async function run(f, args, health) {
  try {
    const r = await exec('bash', [path.join(f.src, 'install', 'update.sh'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: f.home, DOCKLETS_UPDATE_INSTALLER: f.installer,
        DOCKLETS_UPDATE_HEALTH_URL: health ?? 'http://127.0.0.1:9/', DOCKLETS_UPDATE_HEALTH_TIMEOUT: '3' },
    });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { code: e.code, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

test('--check names the newest release and changes nothing', async () => {
  const f = fixture();
  const r = await run(f, ['--check']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /update available: 0\.4\.0 -> 0\.5\.0/);
  assert.equal(f.versionOf(), '0.4.0');
  assert.deepEqual(f.installs(), []);
});

test('an update moves to the newest release, skipping release candidates, and re-runs the installer', async () => {
  const f = fixture();
  const status = { code: 302 };
  const gw = await gateway(status);
  try {
    const r = await run(f, [], gw.url);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /updated docklets 0\.4\.0 -> 0\.5\.0/);
    assert.equal(f.versionOf(), '0.5.0');
    const root = path.join(f.dir, 'root');
    assert.deepEqual(f.installs(), [`0.5.0 ${root} 18089 1`], 'the installer runs once, from the new release, with the saved settings');
  } finally { gw.close(); }
});

test('an install already on the newest release does nothing', async () => {
  const f = fixture();
  const gw = await gateway({ code: 302 });
  try {
    await run(f, [], gw.url);
    const r = await run(f, [], gw.url);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /docklets 0\.5\.0 is up to date/);
    assert.equal(f.installs().length, 1);
  } finally { gw.close(); }
});

test('a checkout with local changes is never updated', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.src, 'package.json'), ' ');
  const r = await run(f, []);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /local changes/);
  assert.deepEqual(f.installs(), []);
});

test('a failed health check rolls back to the release that was running', async () => {
  const f = fixture();
  const before = git(f.src, 'rev-parse', 'HEAD');
  const gw = await gateway({ code: 502 });
  try {
    const r = await run(f, [], gw.url);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /health check failed; rolled back to 0\.4\.0/);
    assert.equal(git(f.src, 'rev-parse', 'HEAD'), before);
    assert.deepEqual(f.installs().map((l) => l.split(' ')[0]), ['0.5.0', '0.4.0']);
  } finally { gw.close(); }
});

test('a rollback puts a checkout that followed main back on main', async () => {
  const f = fixture();
  git(f.src, 'checkout', '-q', '-B', 'main', 'v0.4.0');
  const gw = await gateway({ code: 502 });
  try {
    const r = await run(f, [], gw.url);
    assert.notEqual(r.code, 0);
    assert.equal(git(f.src, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(f.versionOf(), '0.4.0');
  } finally { gw.close(); }
});
