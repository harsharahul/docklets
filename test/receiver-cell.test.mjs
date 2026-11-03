// The receiver's cell mode: one process, one folder per tenant under the
// root, each tenant chosen by a header the control plane sets and proven
// by that tenant's own hashes. Nothing a tenant does reaches another's
// folder, and a tenant's folder can be removed whole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RECEIVER = new URL('../bin/receiver.mjs', import.meta.url).pathname;
const TOK = { alpha: 'dksync_alpha_token', bravo: 'dksync_bravo_token', admin: 'dkcell_admin_token' };
let root, hashDir, base, child;

const hashOf = (token) => execFileSync(process.execPath, [RECEIVER, '--hash', token], { encoding: 'utf8' }).trim();
const sha = (s) => createHash('sha256').update(s).digest('hex');

function api(method, p, { tenant, token, body, raw } = {}) {
  return fetch(base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'x-docklets-tenant': tenant } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
}

async function fullSync(tenant, files, extra = {}) {
  const token = TOK[tenant];
  const start = await api('POST', '/sync/start', { tenant, token, body: { files: files.map(({ path: p, data }) => ({
    path: p, size: Buffer.byteLength(data), sha256: sha(data),
  })), ...extra } });
  assert.equal(start.status, 200, `${tenant} start ${start.status}`);
  const s = await start.json();
  for (const p of s.need) {
    const f = files.find((x) => x.path === p);
    const r = await api('PUT', `/sync/file?session=${s.session}&path=${encodeURIComponent(p)}`, { tenant, token, raw: f.data });
    assert.equal(r.status, 200, p);
  }
  const fin = await api('POST', '/sync/finish', { tenant, token, body: { session: s.session } });
  assert.equal(fin.status, 200);
  return { ...(await fin.json()), start: s };
}

const tree = (dir) => {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out[r] = sha(fs.readFileSync(path.join(d, e.name)));
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cell-'));
  hashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cellhash-'));
  fs.writeFileSync(path.join(hashDir, 'alpha'), hashOf(TOK.alpha) + '\n' + hashOf('dkagent_alpha') + '\n');
  fs.writeFileSync(path.join(hashDir, 'bravo'), hashOf(TOK.bravo) + '\n');
  const adminHash = path.join(hashDir, '.cell-admin');
  fs.writeFileSync(adminHash, hashOf(TOK.admin) + '\n');
  child = spawn(process.execPath, [RECEIVER], {
    env: { ...process.env, DOCKLETS_ROOT: root, DOCKLETS_SYNC_HASH_DIR: hashDir, DOCKLETS_CELL_ADMIN_HASH_FILE: adminHash,
      DOCKLETS_RECEIVER_PORT: '0', DOCKLETS_SYNC_MAX_BYTES: '1000000', DOCKLETS_SYNC_MAX_FILE_BYTES: '500000' },
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = out.match(/receiver listening on (http:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error(`receiver exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
  });
});
after(() => child.kill());

test('cell mode advertises itself and requires the tenant header', async () => {
  const h = await (await fetch(base + '/healthz')).json();
  assert.ok(h.features.includes('cell'), 'healthz does not advertise cell mode');
  assert.equal((await api('GET', '/sync/manifest', { token: TOK.alpha })).status, 400, 'no tenant header accepted');
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'Not A Name', token: TOK.alpha })).status, 400);
  assert.equal((await api('GET', '/sync/manifest', { tenant: '../alpha', token: TOK.alpha })).status, 400);
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'charlie', token: TOK.alpha })).status, 401, 'an unknown tenant did not 401');
});

test('the header only selects which hashes are checked: a token never opens another tenant', async () => {
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'bravo', token: TOK.alpha })).status, 401);
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'alpha', token: TOK.bravo })).status, 401);
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'alpha', token: TOK.alpha })).status, 200);
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'alpha', token: 'dkagent_alpha' })).status, 200, 'the second hash line (the agent token) does not authorize');
});

test('each tenant syncs into its own folder and never touches another', async () => {
  const b1 = await fullSync('bravo', [{ path: 'site/index.html', data: 'bravo home' }, { path: 'site/css/a.css', data: 'b{}' }]);
  assert.equal(b1.added, 2);
  const bravoBefore = tree(path.join(root, 'bravo'));
  const a1 = await fullSync('alpha', [{ path: 'notes/index.html', data: 'alpha notes' }, { path: 'api/app.json', data: JSON.stringify({ runtime: 'worker', entry: 'worker.js' }) }, { path: 'api/worker.js', data: '//' }]);
  assert.equal(a1.added, 3);
  assert.equal(fs.readFileSync(path.join(root, 'alpha', 'notes', 'index.html'), 'utf8'), 'alpha notes');
  assert.ok(fs.existsSync(path.join(root, 'alpha', 'api', '.worker')), 'worker marker not kept per tenant root');
  assert.deepEqual(tree(path.join(root, 'bravo')), bravoBefore, "alpha's sync changed bravo's folder");
  // A mirror sync by alpha with nothing in it empties alpha only.
  const a2 = await fullSync('alpha', [], { });
  assert.equal(a2.deleted, 3);
  assert.deepEqual(tree(path.join(root, 'bravo')), bravoBefore, "alpha's mirror delete reached bravo");
  const m = await (await api('GET', '/sync/manifest', { tenant: 'bravo', token: TOK.bravo })).json();
  assert.deepEqual(m.files.map((f) => f.path), ['site/css/a.css', 'site/index.html']);
  assert.equal((await api('GET', '/sync/file?path=site/index.html', { tenant: 'alpha', token: TOK.alpha })).status, 404, "alpha read bravo's file");
});

test('sessions are per tenant: one tenant mid-session never blocks another', async () => {
  const start = await api('POST', '/sync/start', { tenant: 'alpha', token: TOK.alpha, body: { files: [{ path: 'a.txt', size: 1, sha256: sha('x') }] } });
  assert.equal(start.status, 200);
  const s = await start.json();
  const b = await fullSync('bravo', [{ path: 'site/index.html', data: 'bravo v2' }]);
  assert.equal(b.updated, 1);
  const again = await api('POST', '/sync/start', { tenant: 'alpha', token: TOK.alpha, body: { files: [] } });
  assert.equal(again.status, 409, "alpha's own second start was not refused");
  assert.equal((await api('POST', '/sync/abort', { tenant: 'alpha', token: TOK.alpha, body: { session: s.session } })).status, 200);
  assert.equal((await api('POST', '/sync/abort', { tenant: 'bravo', token: TOK.bravo, body: { session: s.session } })).status, 404, "bravo could act on alpha's session");
});

test('a fresh tenant folder gets the status dashboard and a status feed after its first sync', async () => {
  await fullSync('alpha', [{ path: 'hello/index.html', data: 'hi' }, { path: 'w/app.json', data: JSON.stringify({ runtime: 'worker', entry: 'w.js' }) }, { path: 'w/w.js', data: '//' }]);
  assert.ok(fs.existsSync(path.join(root, 'alpha', 'status', 'index.html')), 'dashboard not seeded into the tenant root');
  const feed = JSON.parse(fs.readFileSync(path.join(root, 'alpha', '.status.json'), 'utf8'));
  assert.deepEqual(feed.static, ['hello']);
  assert.deepEqual(feed.apps, [{ slug: 'w', state: 'pending' }]);
  assert.ok(!fs.existsSync(path.join(root, 'bravo', '.status.json')) || !JSON.parse(fs.readFileSync(path.join(root, 'bravo', '.status.json'), 'utf8')).static.includes('hello'));
});

test('purge removes a tenant folder whole, with that tenant\'s own credential', async () => {
  assert.equal((await api('POST', '/sync/purge', { tenant: 'alpha', token: TOK.bravo })).status, 401);
  const r = await api('POST', '/sync/purge', { tenant: 'alpha', token: TOK.alpha });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false, 'tenant folder survived purge');
  assert.ok(fs.existsSync(path.join(root, 'bravo', 'site', 'index.html')), "purge took bravo's folder");
  assert.deepEqual((await (await api('GET', '/sync/roots', { token: TOK.admin })).json()).roots, ['bravo']);
  // The tenant is still authorized (its hashes exist); its folder comes back empty on the next request.
  assert.equal((await api('GET', '/sync/manifest', { tenant: 'alpha', token: TOK.alpha })).status, 200);
  assert.ok(fs.existsSync(path.join(root, 'alpha', 'status', 'index.html')), 'a purged tenant did not get a fresh dashboard');
});

test('roots lists the tenant folders on disk for the cell credential only', async () => {
  assert.equal((await api('GET', '/sync/roots', { token: TOK.alpha, tenant: 'alpha' })).status, 401);
  assert.equal((await api('GET', '/sync/roots', { token: TOK.bravo })).status, 401);
  fs.mkdirSync(path.join(root, 'lost+found'), { recursive: true });
  const r = await api('GET', '/sync/roots', { token: TOK.admin });
  assert.equal(r.status, 200);
  const { roots } = await r.json();
  assert.deepEqual(roots, ['alpha', 'bravo']);
});

test('single-root mode is unchanged: no header needed, no cell feature, no purge', async () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-single-'));
  const hashFile = path.join(hashDir, 'single-hash');
  fs.writeFileSync(hashFile, hashOf('dksync_single') + '\n');
  const proc = spawn(process.execPath, [RECEIVER], { env: { ...process.env, DOCKLETS_ROOT: r2, DOCKLETS_SYNC_TOKEN_HASH_FILE: hashFile, DOCKLETS_RECEIVER_PORT: '0' } });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => { out += d; const m = out.match(/receiver listening on (http:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    proc.on('exit', (c) => reject(new Error(`exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error('no listen line')), 5000);
  });
  try {
    const h = await (await fetch(url + '/healthz')).json();
    assert.ok(!h.features.includes('cell'));
    assert.equal((await fetch(url + '/sync/manifest', { headers: { authorization: 'Bearer dksync_single' } })).status, 200);
    assert.equal((await fetch(url + '/sync/purge', { method: 'POST', headers: { authorization: 'Bearer dksync_single' } })).status, 404);
  } finally { proc.kill(); }
});
