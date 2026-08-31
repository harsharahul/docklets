import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RECEIVER = new URL('../bin/receiver.mjs', import.meta.url).pathname;
const SYNC = new URL('../bin/sync.mjs', import.meta.url).pathname;
const TOKEN = 'dksync_client_test';
let serverRoot, base, child;

before(async () => {
  serverRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-syncsrv-'));
  const hashFile = path.join(os.tmpdir(), `dk-hash-c-${process.pid}`);
  fs.writeFileSync(hashFile,
    execFileSync(process.execPath, [RECEIVER, '--hash', TOKEN], { encoding: 'utf8' }));
  child = spawn(process.execPath, [RECEIVER], {
    env: { ...process.env, DOCKLETS_ROOT: serverRoot, DOCKLETS_RECEIVER_PORT: '0',
      DOCKLETS_SYNC_TOKEN_HASH_FILE: hashFile },
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/receiver listening on (http:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
  });
});
after(() => child.kill());

function runSync(folder, args = []) {
  return spawnSync(process.execPath, [SYNC, ...args, folder], {
    encoding: 'utf8',
    env: { ...process.env, DOCKLETS_SYNC_URL: base, DOCKLETS_SYNC_TOKEN: TOKEN },
  });
}

test('round trip: add, update, delete land on the server', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-local-'));
  fs.mkdirSync(path.join(local, 'notes'));
  fs.writeFileSync(path.join(local, 'index.html'), 'v1');
  fs.writeFileSync(path.join(local, 'notes', 'a.md'), 'a');

  let r = runSync(local);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /added 2/);
  assert.equal(fs.readFileSync(path.join(serverRoot, 'index.html'), 'utf8'), 'v1');

  fs.writeFileSync(path.join(local, 'index.html'), 'v2');
  fs.rmSync(path.join(local, 'notes'), { recursive: true });
  r = runSync(local);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /updated 1/);
  assert.match(r.stdout, /deleted 1/);
  assert.equal(fs.readFileSync(path.join(serverRoot, 'index.html'), 'utf8'), 'v2');
  assert.ok(!fs.existsSync(path.join(serverRoot, 'notes')));
});

test('dry run reports the plan and changes nothing', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-local2-'));
  fs.writeFileSync(path.join(local, 'new.txt'), 'n');
  const r = runSync(local, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would upload 1/);
  assert.match(r.stdout, /would delete 1/); // index.html from the previous test
  assert.ok(!fs.existsSync(path.join(serverRoot, 'new.txt')));
  assert.ok(fs.existsSync(path.join(serverRoot, 'index.html')));
});

test('an empty folder is refused without --yes', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-empty-'));
  const r = runSync(local);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--yes/);
});

test('a wrong token fails with a clear message', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-local3-'));
  fs.writeFileSync(path.join(local, 'x.txt'), 'x');
  const r = spawnSync(process.execPath, [SYNC, local], {
    encoding: 'utf8',
    env: { ...process.env, DOCKLETS_SYNC_URL: base, DOCKLETS_SYNC_TOKEN: 'nope' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unauthorized/i);
});
