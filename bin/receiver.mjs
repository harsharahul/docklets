#!/usr/bin/env node
/**
 * docklets sync receiver: the server side of `docklets sync`.
 *
 * Applies mirror-style folder syncs to a folder. A sync is a session: the
 * client declares the full desired manifest, uploads only what changed
 * into a hidden staging area, then finish moves files into place, deletes
 * what the manifest no longer contains, and clears the staging area. The
 * live tree never holds a half-applied sync: converge honors .sync-lock
 * during the brief finish step. One exception to the mirror keeps private
 * docklets private: a slug's access.json that the manifest omits is kept
 * while the slug has other files, unless start names the slug in `public`.
 *
 * Two shapes, one process:
 * - One folder ($DOCKLETS_ROOT) with its hash file(s): the default.
 * - A cell: one folder per tenant under $DOCKLETS_ROOT, chosen by the
 *   X-Docklets-Tenant header, with that tenant's hashes in
 *   $DOCKLETS_SYNC_HASH_DIR/<tenant>. The header only selects which hashes
 *   are checked; the bearer token must verify against them, so a header
 *   alone opens nothing. Sessions, locks, and staging are per tenant.
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
 * relative paths. Dot-entries, symlinks, and the reserved top-level names
 * (the status dashboard, lost+found) are never read, written, or deleted
 * (see sync-common.mjs).
 *
 * Usage:
 *   node receiver.mjs                 # serve (env below)
 *   node receiver.mjs --hash TOKEN    # print the scrypt hash for TOKEN
 *
 * Env: DOCKLETS_ROOT, DOCKLETS_SYNC_TOKEN_HASH_FILE,
 *   DOCKLETS_SYNC_TOKEN_HASH_FILES (optional, colon-separated extras),
 *   DOCKLETS_SYNC_HASH_DIR (cell mode: a directory of per-tenant hash
 *   files; replaces the hash file), DOCKLETS_CELL_ADMIN_HASH_FILE (cell
 *   mode: the credential that may list tenant folders),
 *   DOCKLETS_RECEIVER_PORT (9000; 0 picks a free port),
 *   DOCKLETS_RECEIVER_ADDR (127.0.0.1), DOCKLETS_SYNC_MAX_BYTES (2 GiB),
 *   DOCKLETS_SYNC_MAX_FILES (20000), DOCKLETS_SYNC_MAX_FILE_BYTES (100 MiB),
 *   DOCKLETS_DASHBOARD (bundled dashboard dir, seeded to <root>/status once).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { RESERVED_TOP, validRelPath, hashFile, scryptHash, scryptVerifyAsync, markWorkers, writeStatusFeed } from './sync-common.mjs';

if (process.argv[2] === '--hash') {
  const t = process.argv[3];
  if (!t) { console.error('usage: receiver.mjs --hash TOKEN'); process.exit(1); }
  console.log(scryptHash(t));
  process.exit(0);
}

const ROOT = path.resolve(process.env.DOCKLETS_ROOT || '');
const HASH_FILE = process.env.DOCKLETS_SYNC_TOKEN_HASH_FILE || '';
const EXTRA_HASH_FILES = (process.env.DOCKLETS_SYNC_TOKEN_HASH_FILES || '').split(':').filter(Boolean);
const HASH_DIR = process.env.DOCKLETS_SYNC_HASH_DIR ? path.resolve(process.env.DOCKLETS_SYNC_HASH_DIR) : '';
const CELL_ADMIN_HASH_FILE = process.env.DOCKLETS_CELL_ADMIN_HASH_FILE || '';
const PORT = Number(process.env.DOCKLETS_RECEIVER_PORT ?? 9000);
const ADDR = process.env.DOCKLETS_RECEIVER_ADDR || '127.0.0.1';
const MAX_BYTES = Number(process.env.DOCKLETS_SYNC_MAX_BYTES || 2 * 1024 ** 3);
const MAX_FILES = Number(process.env.DOCKLETS_SYNC_MAX_FILES || 20000);
const MAX_FILE = Number(process.env.DOCKLETS_SYNC_MAX_FILE_BYTES || 100 * 1024 ** 2);
const DASHBOARD = process.env.DOCKLETS_DASHBOARD
  || new URL('../dashboard', import.meta.url).pathname;
const SESSION_TTL = 600_000;
const VERIFIED_TTL = 60_000;
const CELL = Boolean(HASH_DIR);
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,39}[a-z0-9])?$/;

if (!ROOT || !fs.existsSync(ROOT)) { console.error(`DOCKLETS_ROOT does not exist: ${ROOT}`); process.exit(1); }
if (!CELL && !HASH_FILE) { console.error('DOCKLETS_SYNC_TOKEN_HASH_FILE is required'); process.exit(1); }
if (CELL && !fs.existsSync(HASH_DIR)) { console.error(`DOCKLETS_SYNC_HASH_DIR does not exist: ${HASH_DIR}`); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------------- *
 * Tenant contexts: one per folder. Single mode has exactly one; a cell has
 * one per tenant, created on the first authorized request.
 * ------------------------------------------------------------------------- */

const contexts = new Map();

function makeContext(name) {
  const root = CELL ? path.join(ROOT, name) : ROOT;
  return {
    name, root,
    lock: path.join(root, '.sync-lock'),
    hashFiles: CELL ? [path.join(HASH_DIR, name)] : [HASH_FILE, ...EXTRA_HASH_FILES],
    session: null, // one at a time: { id, files:Map, need:Set, received:Set, existed:Set, staging, createdAt, bytes }
    lastAuthFailLog: 0,
    prepared: false,
  };
}

/** Leftovers from a crashed session never block the next one; the dashboard
 *  and the worker markers are in place before the folder serves. */
function prepare(ctx) {
  if (ctx.prepared) return;
  fs.mkdirSync(ctx.root, { recursive: true });
  for (const e of fs.readdirSync(ctx.root)) {
    if (e.startsWith('.staging-')) fs.rmSync(path.join(ctx.root, e), { recursive: true, force: true });
  }
  try { if (Date.now() - fs.statSync(ctx.lock).mtimeMs > SESSION_TTL) fs.unlinkSync(ctx.lock); } catch {}
  const dest = path.join(ctx.root, 'status');
  if (!fs.existsSync(dest) && fs.existsSync(DASHBOARD)) {
    fs.cpSync(DASHBOARD, dest, { recursive: true });
    log(`${ctx.name ? ctx.name + ': ' : ''}seeded status dashboard`);
  }
  markWorkers(ctx.root);
  ctx.prepared = true;
}

function contextFor(name) {
  let ctx = contexts.get(name);
  if (!ctx) { ctx = makeContext(name); contexts.set(name, ctx); }
  return ctx;
}

/* ------------------------------------------------------------------------- *
 * Auth
 * ------------------------------------------------------------------------- */

/** Every stored hash, one per non-blank line across the primary file and
 *  any readable extra file; null when the primary cannot be read. */
function storedHashes(files) {
  let lines;
  try { lines = fs.readFileSync(files[0], 'utf8').split('\n'); } catch { return null; }
  for (const f of files.slice(1)) {
    // Extras are optional by design: a missing one is not a failure.
    try { lines.push(...fs.readFileSync(f, 'utf8').split('\n')); } catch {}
  }
  return lines.map((l) => l.trim()).filter(Boolean);
}

// A token verified against a set of hashes stays verified for a minute, so
// a sync's many uploads cost one scrypt, not one each.
const verified = new Map(); // `${scope}:${sha256(token)}` -> { at, hashes }
const digest = (s) => createHash('sha256').update(s).digest('hex');

async function verifyAgainst(scope, given, hashes) {
  const key = `${scope}:${digest(given)}`;
  const hit = verified.get(key);
  const joined = hashes.join('\n');
  if (hit && Date.now() - hit.at < VERIFIED_TTL && hit.hashes === joined) return true;
  for (const h of hashes) {
    if (await scryptVerifyAsync(given, h)) { verified.set(key, { at: Date.now(), hashes: joined }); return true; }
  }
  return false;
}

const bearerOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

/** 'ok' | 'bad' | 'unavailable' for this tenant's hash files. */
async function auth(req, ctx) {
  const stored = storedHashes(ctx.hashFiles);
  if (!stored) return 'unavailable';
  const given = bearerOf(req);
  if (given && await verifyAgainst(ctx.name || '.', given, stored)) return 'ok';
  const now = Date.now();
  if (now - ctx.lastAuthFailLog > 60_000) { ctx.lastAuthFailLog = now; log(`${ctx.name ? ctx.name + ': ' : ''}rejected unauthorized request(s)`); }
  return 'bad';
}

/* ------------------------------------------------------------------------- *
 * Sessions
 * ------------------------------------------------------------------------- */

function dropSession(ctx, s) {
  try { fs.rmSync(s.staging, { recursive: true, force: true }); } catch {}
  if (ctx.session && ctx.session.id === s.id) ctx.session = null;
}

function freshSession(ctx) {
  if (ctx.session && Date.now() - ctx.session.createdAt > SESSION_TTL) dropSession(ctx, ctx.session);
  return ctx.session;
}

/** The session uploads and finish may act on: started, not merely reserved. */
function activeSession(ctx) {
  const s = freshSession(ctx);
  return s && !s.starting ? s : null;
}

/** Every entry currently in the live tree, by manifest rules. */
function liveFiles(ctx) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && RESERVED_TOP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { out.push({ path: r, file: false }); continue; }
      if (e.isDirectory()) { walk(p, r); continue; }
      out.push({ path: r, file: e.isFile() });
    }
  };
  walk(ctx.root, '');
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

/**
 * Omission never makes a docklet public: a slug's access.json that a session
 * leaves out survives while the slug keeps other files, unless the session
 * names the slug in `public`. Removing the whole slug removes it too.
 */
function keptLocks(gone, manifest, pub) {
  const kept = new Set();
  for (const p of gone) {
    const m = /^([^/]+)\/access\.json$/.exec(p);
    if (!m || pub.has(m[1])) continue;
    for (const q of manifest.keys()) if (q.startsWith(`${m[1]}/`)) { kept.add(p); break; }
  }
  return kept;
}

async function handleStart(ctx, body) {
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
  const pub = body.public ?? [];
  if (!Array.isArray(pub) || !pub.every((s) => validRelPath(s) && !s.includes('/'))) {
    return { code: 400, body: { error: 'public must be a list of slugs' } };
  }
  if (freshSession(ctx)) return { code: 409, body: { error: 'sync already in progress' } };

  // Reserve the slot before the first await: hashing the files already on
  // disk yields to other requests, and a second start in that window must
  // see a session in progress rather than silently replace this one.
  const id = randomBytes(16).toString('hex');
  ctx.session = { id, starting: true, createdAt: Date.now() };
  try {
    const manifest = new Map(files.map((f) => [f.path, f]));
    const need = [];
    const existed = new Set();
    for (const [p, f] of manifest) {
      const live = path.join(ctx.root, p);
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
    const gone = liveFiles(ctx).map((e) => e.path).filter((p) => !manifest.has(p));
    const kept = keptLocks(gone, manifest, new Set(pub));
    const extraneous = gone.filter((p) => !kept.has(p)).sort();
    ctx.session = { id, files: manifest, need: new Set(need), received: new Set(), existed, pub: new Set(pub),
      staging: path.join(ctx.root, `.staging-${id}`), createdAt: Date.now(), bytes: 0 };
    fs.mkdirSync(ctx.session.staging, { recursive: true });
    log(`${ctx.name ? ctx.name + ': ' : ''}sync start: ${files.length} files, ${need.length} to upload, ${extraneous.length} extraneous, ${kept.size} kept private`);
    return { code: 200, body: { session: id, need: need.sort(), extraneous, kept: [...kept].sort() } };
  } catch (e) {
    if (ctx.session && ctx.session.id === id) ctx.session = null;
    throw e;
  }
}

/** The live tree as a sync manifest: path, size, sha256, sorted by path. */
async function liveManifest(ctx) {
  const out = [];
  for (const e of liveFiles(ctx)) {
    if (!e.file) continue;
    const live = path.join(ctx.root, e.path);
    out.push({ path: e.path, size: fs.statSync(live).size, sha256: await hashFile(live) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function handleRead(ctx, res, u) {
  const p = u.searchParams.get('path') || '';
  // validRelPath refuses dot-entries and the status folder, so nothing the
  // sync would not write is ever readable here either.
  if (!validRelPath(p)) return sendJson(res, 400, { error: 'bad path' });
  const live = path.join(ctx.root, p);
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

function handleUpload(ctx, req, res, u) {
  const s = activeSession(ctx);
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

function handleFinish(ctx, body) {
  const s = activeSession(ctx);
  if (!s || body?.session !== s.id) return { code: 404, body: { error: 'unknown session' } };
  const missing = [...s.need].filter((p) => !s.received.has(p));
  if (missing.length) return { code: 409, body: { error: 'missing files', missing: missing.slice(0, 20) } };

  fs.writeFileSync(ctx.lock, s.id);
  try {
    // rename replaces a file atomically, so there is never a moment without
    // it (a slug's access.json included).
    for (const p of s.received) {
      const dest = path.join(ctx.root, p);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(s.staging, p), dest);
    }
    // Kept locks are decided again against the tree as it is now: an
    // access.json written on this side after start must survive too.
    const gone = liveFiles(ctx).map((e) => e.path).filter((p) => !s.files.has(p));
    const kept = keptLocks(gone, s.files, s.pub);
    let deleted = 0;
    for (const p of gone) {
      if (!kept.has(p)) { fs.rmSync(path.join(ctx.root, p), { force: true }); deleted++; }
    }
    pruneEmptyDirs(ctx.root);
    // Worker slugs carry their routing marker; a manifest that stopped
    // naming the worker runtime loses it in the same step. A cell has no
    // deployer, so the status feed is written here too.
    markWorkers(ctx.root);
    if (CELL) writeStatusFeed(ctx.root);
    const added = [...s.received].filter((p) => !s.existed.has(p)).length;
    const summary = { ok: true, added, updated: s.received.size - added, deleted, bytes: s.bytes };
    log(`${ctx.name ? ctx.name + ': ' : ''}sync finish: +${added} ~${summary.updated} -${deleted} (${s.bytes} bytes)`);
    dropSession(ctx, s);
    return { code: 200, body: summary };
  } finally {
    try { fs.unlinkSync(ctx.lock); } catch {}
  }
}

function pruneEmptyDirs(dir, top = true) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || (top && RESERVED_TOP.has(e.name)) || !e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    pruneEmptyDirs(p, false);
    try { fs.rmdirSync(p); } catch {} // fails while non-empty, which is the point
  }
}

/** Cell mode: a tenant's folder goes away whole (its credential stays
 *  valid; the next sync starts it again). */
function handlePurge(ctx) {
  if (ctx.session) dropSession(ctx, ctx.session);
  let removed = 0;
  if (fs.existsSync(ctx.root)) {
    removed = liveFiles(ctx).length;
    fs.rmSync(ctx.root, { recursive: true, force: true });
  }
  ctx.prepared = false;
  log(`${ctx.name}: purged (${removed} files)`);
  return { ok: true, removed };
}

/** Cell mode: the tenant folders on disk, for the control plane's sweep. */
function tenantRoots() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name) && !RESERVED_TOP.has(e.name))
    .map((e) => e.name).sort();
}

function sendJson(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/* ------------------------------------------------------------------------- *
 * Boot and serve
 * ------------------------------------------------------------------------- */

if (!CELL) {
  prepare(contextFor(''));
} else {
  for (const name of tenantRoots()) {
    if (fs.existsSync(path.join(HASH_DIR, name))) prepare(contextFor(name));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'receiver'}`);
    if (req.method === 'GET' && u.pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, features: ['access', ...(CELL ? ['cell'] : [])] });
    }
    if (CELL && req.method === 'GET' && u.pathname === '/sync/roots') {
      const stored = CELL_ADMIN_HASH_FILE ? storedHashes([CELL_ADMIN_HASH_FILE]) : null;
      if (!stored) return sendJson(res, 503, { error: 'cell credential unreadable, failing closed' });
      const given = bearerOf(req);
      if (!given || !(await verifyAgainst('.cell', given, stored))) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { roots: tenantRoots() });
    }
    let ctx;
    if (CELL) {
      const name = String(req.headers['x-docklets-tenant'] ?? '');
      if (!name) return sendJson(res, 400, { error: 'tenant required' });
      if (!NAME_RE.test(name) || name.endsWith('-')) return sendJson(res, 400, { error: 'bad tenant' });
      if (!fs.existsSync(path.join(HASH_DIR, name))) return sendJson(res, 401, { error: 'unauthorized' });
      ctx = contextFor(name);
    } else {
      ctx = contextFor('');
    }
    const a = await auth(req, ctx);
    if (a === 'unavailable') return sendJson(res, 503, { error: 'token hash unreadable, failing closed' });
    if (a !== 'ok') return sendJson(res, 401, { error: 'unauthorized' });
    prepare(ctx);
    if (req.method === 'GET' && u.pathname === '/sync/manifest') return sendJson(res, 200, { files: await liveManifest(ctx) });
    if (req.method === 'GET' && u.pathname === '/sync/file') return handleRead(ctx, res, u);
    if (req.method === 'PUT' && u.pathname === '/sync/file') return handleUpload(ctx, req, res, u);
    if (CELL && req.method === 'POST' && u.pathname === '/sync/purge') return sendJson(res, 200, handlePurge(ctx));
    if (req.method === 'POST' && ['/sync/start', '/sync/finish', '/sync/abort'].includes(u.pathname)) {
      let body;
      try { body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}'); }
      catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: 'bad request body' }); }
      if (u.pathname === '/sync/start') { const r = await handleStart(ctx, body); return sendJson(res, r.code, r.body); }
      if (u.pathname === '/sync/finish') { const r = handleFinish(ctx, body); return sendJson(res, r.code, r.body); }
      const s = activeSession(ctx);
      if (!s || body?.session !== s.id) return sendJson(res, 404, { error: 'unknown session' });
      dropSession(ctx, s);
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
  console.log(`receiver listening on http://${ADDR}:${port}${CELL ? ' (cell mode)' : ''}`);
});
