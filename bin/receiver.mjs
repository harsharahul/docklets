#!/usr/bin/env node
/**
 * docklets sync receiver: the server side of `docklets sync`.
 *
 * Applies mirror-style folder syncs to $DOCKLETS_ROOT. A sync is a session:
 * the client declares the full desired manifest, uploads only what changed
 * into a hidden staging area, then finish moves files into place, deletes
 * what the manifest no longer contains, and clears the staging area. The
 * live tree never holds a half-applied sync: converge honors .sync-lock
 * during the brief finish step.
 *
 * Auth: every request (except /healthz) carries a plaintext token as a
 * bearer header, verified against scrypt hashes on disk. The plaintext is
 * never stored here. Hash files are re-read per request, so rotating a
 * token needs no restart; an unreadable primary hash file fails closed.
 * A hash file holds one hash per line, and DOCKLETS_SYNC_TOKEN_HASH_FILES
 * names optional extra files, so a second writer (another machine, or a
 * managed control plane) can hold its own token and be revoked alone.
 *
 * Reads: GET /sync/manifest lists the live tree by manifest rules and
 * GET /sync/file?path= returns one file, so a client can express a partial
 * change as the full mirror the protocol requires.
 *
 * What a synced folder can contain: regular files with forward-slash
 * relative paths. Dot-entries, symlinks, and the reserved status dashboard
 * are never written and never deleted (see sync-common.mjs).
 *
 * Usage:
 *   node receiver.mjs                 # serve (env below)
 *   node receiver.mjs --hash TOKEN    # print the scrypt hash for TOKEN
 *
 * Env: DOCKLETS_ROOT, DOCKLETS_SYNC_TOKEN_HASH_FILE,
 *   DOCKLETS_SYNC_TOKEN_HASH_FILES (optional, colon-separated extras),
 *   DOCKLETS_RECEIVER_PORT (9000; 0 picks a free port),
 *   DOCKLETS_RECEIVER_ADDR (127.0.0.1), DOCKLETS_SYNC_MAX_BYTES (2 GiB),
 *   DOCKLETS_SYNC_MAX_FILES (20000), DOCKLETS_SYNC_MAX_FILE_BYTES (100 MiB),
 *   DOCKLETS_DASHBOARD (bundled dashboard dir, seeded to <root>/status once).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { validRelPath, hashFile, scryptHash, scryptVerify } from './sync-common.mjs';

if (process.argv[2] === '--hash') {
  const t = process.argv[3];
  if (!t) { console.error('usage: receiver.mjs --hash TOKEN'); process.exit(1); }
  console.log(scryptHash(t));
  process.exit(0);
}

const ROOT = path.resolve(process.env.DOCKLETS_ROOT || '');
const HASH_FILE = process.env.DOCKLETS_SYNC_TOKEN_HASH_FILE || '';
const EXTRA_HASH_FILES = (process.env.DOCKLETS_SYNC_TOKEN_HASH_FILES || '').split(':').filter(Boolean);
const PORT = Number(process.env.DOCKLETS_RECEIVER_PORT ?? 9000);
const ADDR = process.env.DOCKLETS_RECEIVER_ADDR || '127.0.0.1';
const MAX_BYTES = Number(process.env.DOCKLETS_SYNC_MAX_BYTES || 2 * 1024 ** 3);
const MAX_FILES = Number(process.env.DOCKLETS_SYNC_MAX_FILES || 20000);
const MAX_FILE = Number(process.env.DOCKLETS_SYNC_MAX_FILE_BYTES || 100 * 1024 ** 2);
const DASHBOARD = process.env.DOCKLETS_DASHBOARD
  || new URL('../dashboard', import.meta.url).pathname;
const SESSION_TTL = 600_000;
const LOCK = path.join(ROOT, '.sync-lock');

if (!ROOT || !fs.existsSync(ROOT)) { console.error(`DOCKLETS_ROOT does not exist: ${ROOT}`); process.exit(1); }
if (!HASH_FILE) { console.error('DOCKLETS_SYNC_TOKEN_HASH_FILE is required'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
let session = null; // one at a time: { id, files:Map, need:Set, received:Set, existed:Set, staging, createdAt, bytes }
let lastAuthFailLog = 0;

/** Every stored hash, one per non-blank line across the primary file and
 *  any readable extra file; null when the primary cannot be read. */
function storedHashes() {
  let lines;
  try { lines = fs.readFileSync(HASH_FILE, 'utf8').split('\n'); } catch { return null; }
  for (const f of EXTRA_HASH_FILES) {
    // Extras are optional by design: a missing one is not a failure.
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

function auth(req) {
  const stored = storedHashes();
  if (!stored) return 'unavailable';
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (given && stored.some((h) => scryptVerify(given, h))) return 'ok';
  const now = Date.now();
  if (now - lastAuthFailLog > 60_000) { lastAuthFailLog = now; log('rejected unauthorized request(s)'); }
  return 'bad';
}

function dropSession(s) {
  try { fs.rmSync(s.staging, { recursive: true, force: true }); } catch {}
  if (session && session.id === s.id) session = null;
}

function freshSession() {
  if (session && Date.now() - session.createdAt > SESSION_TTL) dropSession(session);
  return session;
}

/** The session uploads and finish may act on: started, not merely reserved. */
function activeSession() {
  const s = freshSession();
  return s && !s.starting ? s : null;
}

/** Every entry currently in the live tree, by manifest rules. */
function liveFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && e.name === 'status') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { out.push({ path: r, file: false }); continue; }
      if (e.isDirectory()) { walk(p, r); continue; }
      out.push({ path: r, file: e.isFile() });
    }
  };
  walk(ROOT, '');
  return out;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > cap) { reject(Object.assign(new Error('body too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleStart(body) {
  const files = body?.files;
  if (!Array.isArray(files) || files.length > MAX_FILES) return { code: 400, body: { error: 'bad manifest' } };
  const seen = new Set();
  let total = 0;
  for (const f of files) {
    if (!f || !validRelPath(f.path) || seen.has(f.path)
      || !Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE
      || !/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) {
      return { code: 400, body: { error: `bad manifest entry: ${JSON.stringify(f?.path ?? f)}` } };
    }
    seen.add(f.path);
    total += f.size;
  }
  if (total > MAX_BYTES) return { code: 413, body: { error: 'over quota', maxBytes: MAX_BYTES } };
  if (freshSession()) return { code: 409, body: { error: 'sync already in progress' } };

  // Reserve the slot before the first await: hashing the files already on
  // disk yields to other requests, and a second start in that window must
  // see a session in progress rather than silently replace this one.
  const id = randomBytes(16).toString('hex');
  session = { id, starting: true, createdAt: Date.now() };
  try {
    const manifest = new Map(files.map((f) => [f.path, f]));
    const need = [];
    const existed = new Set();
    for (const [p, f] of manifest) {
      const live = path.join(ROOT, p);
      let same = false;
      try {
        const st = fs.lstatSync(live);
        if (st.isFile()) {
          existed.add(p);
          same = st.size === f.size && (await hashFile(live)) === f.sha256;
        }
      } catch {}
      if (!same) need.push(p);
    }
    const extraneous = liveFiles().map((e) => e.path).filter((p) => !manifest.has(p)).sort();
    session = { id, files: manifest, need: new Set(need), received: new Set(), existed,
      staging: path.join(ROOT, `.staging-${id}`), createdAt: Date.now(), bytes: 0 };
    fs.mkdirSync(session.staging, { recursive: true });
    log(`sync start: ${files.length} files, ${need.length} to upload, ${extraneous.length} extraneous`);
    return { code: 200, body: { session: id, need: need.sort(), extraneous } };
  } catch (e) {
    if (session && session.id === id) session = null;
    throw e;
  }
}

/** The live tree as a sync manifest: path, size, sha256, sorted by path. */
async function liveManifest() {
  const out = [];
  for (const e of liveFiles()) {
    if (!e.file) continue;
    const live = path.join(ROOT, e.path);
    out.push({ path: e.path, size: fs.statSync(live).size, sha256: await hashFile(live) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function handleRead(res, u) {
  const p = u.searchParams.get('path') || '';
  // validRelPath refuses dot-entries and the status folder, so nothing the
  // sync would not write is ever readable here either.
  if (!validRelPath(p)) return sendJson(res, 400, { error: 'bad path' });
  const live = path.join(ROOT, p);
  let st;
  try { st = fs.lstatSync(live); } catch { return sendJson(res, 404, { error: 'no such file' }); }
  if (!st.isFile()) return sendJson(res, 404, { error: 'no such file' });
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'no-store',
  });
  fs.createReadStream(live).on('error', () => res.destroy()).pipe(res);
}

function handleUpload(req, res, u) {
  const s = activeSession();
  const p = u.searchParams.get('path') || '';
  if (!s || u.searchParams.get('session') !== s.id) return sendJson(res, 404, { error: 'unknown session' });
  if (!s.need.has(p)) return sendJson(res, 409, { error: 'path not in need list' });
  const want = s.files.get(p);
  const dest = path.join(s.staging, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const h = createHash('sha256');
  let n = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    out.destroy(); try { fs.unlinkSync(tmp); } catch {}
    sendJson(res, code, { error: msg }); req.destroy();
  };
  req.on('data', (c) => {
    n += c.length;
    if (n > want.size) return fail(413, 'more bytes than declared');
    h.update(c); out.write(c);
  });
  req.on('error', () => fail(400, 'upload aborted'));
  req.on('end', () => {
    if (failed) return;
    out.end(() => {
      if (n !== want.size || h.digest('hex') !== want.sha256) {
        try { fs.unlinkSync(tmp); } catch {}
        return sendJson(res, 422, { error: 'content does not match manifest' });
      }
      fs.renameSync(tmp, dest);
      s.received.add(p);
      s.bytes += n;
      sendJson(res, 200, { ok: true });
    });
  });
}

function handleFinish(body) {
  const s = activeSession();
  if (!s || body?.session !== s.id) return { code: 404, body: { error: 'unknown session' } };
  const missing = [...s.need].filter((p) => !s.received.has(p));
  if (missing.length) return { code: 409, body: { error: 'missing files', missing: missing.slice(0, 20) } };

  fs.writeFileSync(LOCK, s.id);
  try {
    for (const p of s.received) {
      const dest = path.join(ROOT, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.rmSync(dest, { force: true }); } catch {}
      fs.renameSync(path.join(s.staging, p), dest);
    }
    let deleted = 0;
    for (const e of liveFiles()) {
      if (!s.files.has(e.path)) { fs.rmSync(path.join(ROOT, e.path), { force: true }); deleted++; }
    }
    pruneEmptyDirs(ROOT);
    const added = [...s.received].filter((p) => !s.existed.has(p)).length;
    const summary = { ok: true, added, updated: s.received.size - added, deleted, bytes: s.bytes };
    log(`sync finish: +${added} ~${summary.updated} -${deleted} (${s.bytes} bytes)`);
    dropSession(s);
    return { code: 200, body: summary };
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

function pruneEmptyDirs(dir, top = true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || (top && e.name === 'status') || !e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p, false);
    try { fs.rmdirSync(p); } catch {} // fails while non-empty, which is the point
  }
}

function sendJson(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function seedDashboard() {
  const dest = path.join(ROOT, 'status');
  if (fs.existsSync(dest) || !fs.existsSync(DASHBOARD)) return;
  fs.cpSync(DASHBOARD, dest, { recursive: true });
  log('seeded status dashboard');
}

// Leftovers from a crashed session never block the next one.
for (const e of fs.readdirSync(ROOT)) {
  if (e.startsWith('.staging-')) fs.rmSync(path.join(ROOT, e), { recursive: true, force: true });
}
try { if (Date.now() - fs.statSync(LOCK).mtimeMs > SESSION_TTL) fs.unlinkSync(LOCK); } catch {}
seedDashboard();

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'receiver'}`);
    if (req.method === 'GET' && u.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    const a = auth(req);
    if (a === 'unavailable') return sendJson(res, 503, { error: 'token hash unreadable, failing closed' });
    if (a !== 'ok') return sendJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET' && u.pathname === '/sync/manifest') return sendJson(res, 200, { files: await liveManifest() });
    if (req.method === 'GET' && u.pathname === '/sync/file') return handleRead(res, u);
    if (req.method === 'PUT' && u.pathname === '/sync/file') return handleUpload(req, res, u);
    if (req.method === 'POST' && ['/sync/start', '/sync/finish', '/sync/abort'].includes(u.pathname)) {
      let body;
      try { body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}'); }
      catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'bad request body' }); }
      if (u.pathname === '/sync/start') { const r = await handleStart(body); return sendJson(res, r.code, r.body); }
      if (u.pathname === '/sync/finish') { const r = handleFinish(body); return sendJson(res, r.code, r.body); }
      const s = activeSession();
      if (!s || body?.session !== s.id) return sendJson(res, 404, { error: 'unknown session' });
      dropSession(s);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'no such route' });
  } catch (e) {
    log('request error:', String(e.message || e).split('\n')[0]);
    sendJson(res, 500, { error: 'internal error' });
  }
});
server.listen(PORT, ADDR, () => {
  const { port } = server.address();
  console.log(`receiver listening on http://${ADDR}:${port}`);
});
