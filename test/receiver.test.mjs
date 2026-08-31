import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RECEIVER = new URL('../bin/receiver.mjs', import.meta.url).pathname;
const TOKEN = 'dksync_test_token_123';
let root, base, child;

function api(method, p, { body, token = TOKEN, raw } = {}) {
  return fetch(base + p, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-recv-'));
  const hash = execFileSync(process.execPath, [RECEIVER, '--hash', TOKEN], { encoding: 'utf8' }).trim();
  const hashFile = path.join(os.tmpdir(), `dk-hash-${process.pid}`);
  fs.writeFileSync(hashFile, hash + '\n');
  child = spawn(process.execPath, [RECEIVER], {
    env: { ...process.env, DOCKLETS_ROOT: root, DOCKLETS_RECEIVER_PORT: '0',
      DOCKLETS_SYNC_TOKEN_HASH_FILE: hashFile,
      DOCKLETS_SYNC_MAX_BYTES: '1000000', DOCKLETS_SYNC_MAX_FILE_BYTES: '500000' },
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/receiver listening on (http:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', (c) => reject(new Error(`receiver exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
  });
});
after(() => child.kill());

test('healthz needs no auth; everything else does', async () => {
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/sync/start', { method: 'POST' })).status, 401);
  assert.equal((await api('POST', '/sync/start', { token: 'wrong', body: { files: [] } })).status, 401);
});

test('start validates the manifest', async () => {
  for (const files of [
    [{ path: '../evil', size: 1, sha256: 'a'.repeat(64) }],
    [{ path: '.env', size: 1, sha256: 'a'.repeat(64) }],
    [{ path: 'status/x', size: 1, sha256: 'a'.repeat(64) }],
    [{ path: 'ok.txt', size: 1, sha256: 'nothex' }],
    [{ path: 'dup', size: 1, sha256: 'a'.repeat(64) }, { path: 'dup', size: 1, sha256: 'a'.repeat(64) }],
  ]) {
    assert.equal((await api('POST', '/sync/start', { body: { files } })).status, 400);
  }
  // each file is under the per-file cap (500000); the total busts the quota
  const over = ['q1', 'q2', 'q3'].map((p) => ({ path: p, size: 400_000, sha256: 'a'.repeat(64) }));
  assert.equal((await api('POST', '/sync/start', { body: { files: over } })).status, 413);
  // and a single file over the per-file cap is a manifest error, not a quota error
  const huge = [{ path: 'huge', size: 600_000, sha256: 'a'.repeat(64) }];
  assert.equal((await api('POST', '/sync/start', { body: { files: huge } })).status, 400);
});

test('upload round trip: need list, sha verification, staged invisibly', async () => {
  const bytes = 'hello world';
  const sha = createHash('sha256').update(bytes).digest('hex');
  const r = await api('POST', '/sync/start', { body: { files: [{ path: 'a/hello.txt', size: 11, sha256: sha }] } });
  assert.equal(r.status, 200);
  const { session, need } = await r.json();
  assert.deepEqual(need, ['a/hello.txt']);

  const bad = await api('PUT', `/sync/file?session=${session}&path=${encodeURIComponent('a/hello.txt')}`, { raw: 'hello wrong' });
  assert.equal(bad.status, 422);
  const ok = await api('PUT', `/sync/file?session=${session}&path=${encodeURIComponent('a/hello.txt')}`, { raw: bytes });
  assert.equal(ok.status, 200);
  const notNeeded = await api('PUT', `/sync/file?session=${session}&path=elsewhere`, { raw: 'x' });
  assert.equal(notNeeded.status, 409);
  assert.ok(!fs.existsSync(path.join(root, 'a')), 'file reached the live tree before finish');

  const second = await api('POST', '/sync/start', { body: { files: [] } });
  assert.equal(second.status, 409, 'concurrent session accepted');
  await api('POST', '/sync/abort', { body: { session } });
});
