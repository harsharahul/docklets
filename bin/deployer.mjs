#!/usr/bin/env node
/**
 * docklets deployer: converges Docker to match the manifests in your asset root.
 *
 * The control plane is a FILESYSTEM, not a network API. An agent (or human)
 * deploys by writing files into $DOCKLETS_ROOT/<slug>/ and nothing else. This
 * daemon is the only Docker-privileged component; it watches for app.json
 * manifests and runs each dynamic asset as its own hardened container behind
 * the gateway's /<slug>/ route.
 *
 * Configuration (env):
 *   DOCKLETS_ROOT      asset root directory            (default: $PWD)
 *   DOCKLETS_NETWORK   internal docker network         (default: docklets-net)
 *   DOCKLETS_GATEWAY   gateway container name          (default: docklets-gateway)
 *   DOCKLETS_PREFIX    app container name prefix       (default: docklet-)
 *   DOCKLETS_POLL_MS   poll interval                   (default: 7000)
 *   DOCKLETS_DRIVER    app runner: docker | none (status feed only)  (default: docker)
 *   DOCKLETS_MEMORY    per-app memory cap              (default: 512m)
 *   DOCKLETS_PIDS      per-app pid cap                 (default: 256)
 *
 * Usage:
 *   node deployer.mjs           # run forever (service mode)
 *   node deployer.mjs --once    # single converge pass, then exit (testing/CI)
 *
 * Manifest ($DOCKLETS_ROOT/<slug>/app.json):
 *   {
 *     "runtime": "node",          // "node" (node:20-alpine) | "python" (python:3.12-alpine)
 *     "entry":   "server.js",     // relative path inside the slug dir
 *     "port":    3000,            // port the app listens on (also passed as $PORT)
 *     "env":     { "KEY": "v" },  // optional, non-secret env vars
 *     "install": true             // optional: npm install / pip install first
 *   }
 *
 * Container contract:
 *   /src   the slug dir, READ-ONLY (code)
 *   /app   writable copy of /src inside the container (dependency install target)
 *   /data  $DOCKLETS_ROOT/.data/<slug>, READ-WRITE (persistent app state)
 *
 * Hardening per app: cap-drop ALL, no-new-privileges, memory/pid caps, --init,
 * internal network only. No published ports, no docker socket, no host FS.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.DOCKLETS_ROOT || process.cwd());
const NET = process.env.DOCKLETS_NETWORK || 'docklets-net';
const GATEWAY = process.env.DOCKLETS_GATEWAY || 'docklets-gateway';
const PREFIX = process.env.DOCKLETS_PREFIX || 'docklet-';
const POLL_MS = Number(process.env.DOCKLETS_POLL_MS || 7000);
const MEMORY = process.env.DOCKLETS_MEMORY || '512m';
const PIDS = process.env.DOCKLETS_PIDS || '256';
const ONCE = process.argv.includes('--once');
const ADMIN_PORT = Number(process.env.DOCKLETS_ADMIN_PORT || 0);
const DRIVER = process.env.DOCKLETS_DRIVER || 'docker';
if (!['docker', 'none'].includes(DRIVER)) {
  console.error(`DOCKLETS_DRIVER must be "docker" or "none", got "${DRIVER}"`);
  process.exit(1);
}

const ROUTES = path.join(ROOT, '.gateway', 'routes');
const DATA = path.join(ROOT, '.data');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

const RUNTIMES = {
  node: {
    image: 'node:20-alpine',
    install: '[ -f package.json ] && npm install --omit=dev --no-audit --no-fund; ',
    run: (entry) => `exec node ${JSON.stringify(entry)}`,
  },
  python: {
    image: 'python:3.12-alpine',
    install: '[ -f requirements.txt ] && pip install --no-cache-dir --target /app/.deps -r requirements.txt; ',
    run: (entry) => `exec python3 ${JSON.stringify(entry)}`,
  },
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts }).trim();
}

/** docker call where a non-zero exit is expected/benign (rm of absent, create of existing). */
function dockerQuiet(args) {
  try { execFileSync('docker', args, { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Content hash of a slug dir (code only; node_modules and dot-dirs excluded). */
function hashDir(dir) {
  const h = createHash('sha1');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name === '__pycache__' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { h.update(`L:${p}`); continue; }
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      h.update(`${path.relative(dir, p)}:${st.size}:${st.mtimeMs};`);
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

function readManifest(slug) {
  const p = path.join(ROOT, slug, 'app.json');
  if (!fs.existsSync(p) || fs.lstatSync(p).isSymbolicLink()) return null;
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {
    log(`SKIP ${slug}: app.json is not valid JSON`); return null;
  }
  if (!RUNTIMES[m.runtime]) { log(`SKIP ${slug}: unsupported runtime "${m.runtime}" (${Object.keys(RUNTIMES).join('|')})`); return null; }
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { log(`SKIP ${slug}: bad port`); return null; }
  const entry = String(m.entry || '');
  if (!entry || entry.includes('..') || path.isAbsolute(entry)) { log(`SKIP ${slug}: bad entry`); return null; }
  const env = m.env && typeof m.env === 'object' ? m.env : {};
  for (const k of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { log(`SKIP ${slug}: bad env key ${k}`); return null; }
  }
  return { runtime: m.runtime, entry, port, env, install: !!m.install };
}

function desiredApps() {
  const apps = new Map();
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
    const man = readManifest(e.name);
    if (man) apps.set(e.name, { ...man, hash: hashDir(path.join(ROOT, e.name)) });
  }
  return apps;
}

function runningApps() {
  const out = docker(['ps', '-a', '--filter', `label=docklet-root=${ROOT}`,
    '--format', '{{.Names}}\t{{.Label "docklet-hash"}}\t{{.Label "docklet-port"}}\t{{.State}}\t{{.Status}}']);
  const map = new Map();
  for (const line of out ? out.split('\n') : []) {
    const [name, hash, port, state, statusText] = line.split('\t');
    map.set(name.slice(PREFIX.length), { name, hash, port, state, statusText });
  }
  return map;
}

function startApp(slug, app) {
  const rt = RUNTIMES[app.runtime];
  const name = PREFIX + slug;
  const dataDir = path.join(DATA, slug);
  fs.mkdirSync(dataDir, { recursive: true });
  dockerQuiet(['rm', '-f', name]);
  // Copy code to a writable /app (container layer, never the host), optional
  // dependency install, then exec the entry. Slug code itself stays read-only.
  const installStep = app.install ? rt.install : '';
  const cmd = `cp -R /src/. /app && cd /app && ${installStep}${rt.run(app.entry)}`;
  const envArgs = Object.entries(app.env).flatMap(([k, v]) => ['-e', `${k}=${String(v)}`]);
  // Run as the deployer's own uid/gid, not container root: /data (created by
  // this process) stays writable without CAP_DAC_OVERRIDE, and app code never
  // executes with root privileges inside the container. /app and /tmp are
  // per-container tmpfs so the copy step and package managers work as that
  // user; both vanish with the container.
  const uid = `${process.getuid()}:${process.getgid()}`;
  docker(['run', '-d', '--name', name,
    '--user', uid,
    '--tmpfs', '/app:rw,mode=1777',
    '--tmpfs', '/tmp:rw,mode=1777',
    '-e', 'HOME=/tmp',
    '-e', 'PYTHONPATH=/app/.deps',
    '-e', 'npm_config_cache=/tmp/.npm',
    '--label', 'docklet=' + slug,
    '--label', 'docklet-root=' + ROOT,
    '--label', 'docklet-hash=' + app.hash,
    '--label', 'docklet-port=' + String(app.port),
    '--network', NET,
    '--restart', 'unless-stopped',
    '--init',
    '-v', `${path.join(ROOT, slug)}:/src:ro`,
    '-v', `${dataDir}:/data`,
    '-w', '/app',
    '-e', 'NODE_ENV=production', '-e', `PORT=${app.port}`, ...envArgs,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', PIDS,
    '--memory', MEMORY,
    rt.image,
    'sh', '-c', cmd]);
  log(`started ${name} (${app.runtime}, hash ${app.hash}, port ${app.port})`);
}

function routeFile(slug) { return path.join(ROUTES, `${slug}.caddy`); }

function writeRoute(slug, port) {
  const content =
    `# generated by docklets deployer. Do not edit.\n` +
    `redir /${slug} /${slug}/ 308\n` +
    `handle_path /${slug}/* {\n\treverse_proxy ${PREFIX}${slug}:${port}\n}\n`;
  const p = routeFile(slug);
  if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === content) return false;
  fs.writeFileSync(p, content);
  return true;
}

function reloadGateway() {
  try {
    docker(['exec', GATEWAY, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
    log('gateway reloaded');
  } catch (e) { log('gateway reload FAILED:', String(e.message || e).split('\n')[0]); }
}

/** A slug is "paused" when its manifest was renamed aside by the admin plane. */
function isPaused(slug) {
  return fs.existsSync(path.join(ROOT, slug, 'app.json.paused'));
}

/** A sync session holds this lock while it rearranges the tree; converge
 *  waits it out. A stale lock (crashed session) is ignored after 10 minutes. */
function syncLocked() {
  try { return Date.now() - fs.statSync(path.join(ROOT, '.sync-lock')).mtimeMs < 600_000; }
  catch { return false; }
}

/**
 * Public status feed at <root>/.status.json, written atomically each pass.
 * Served by the gateway like any file, so it carries ONLY what the public
 * directory listing already reveals plus coarse run state: no ports, no host
 * paths, no content hashes. The richer view lives behind the admin plane.
 */
function writeStatus(desired, running) {
  const status = { generatedAt: new Date().toISOString(), apps: [], static: [] };
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
    const slug = e.name;
    if (desired.has(slug)) {
      status.apps.push({ slug, state: DRIVER === 'none' ? 'pending'
        : running.get(slug)?.state === 'running' ? 'running' : (running.get(slug)?.state ?? 'starting') });
    } else if (isPaused(slug)) {
      status.apps.push({ slug, state: 'paused' });
    } else {
      status.static.push(slug);
    }
  }
  const tmp = path.join(ROOT, '.status.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, path.join(ROOT, '.status.json'));
}

function converge() {
  if (syncLocked()) { log('sync in progress; skipping converge'); return; }
  const desired = desiredApps();
  if (DRIVER === 'none') {
    // No app runner on this deployment: publish what exists and stop there.
    writeStatus(desired, new Map());
    return;
  }
  const running = runningApps();
  let routesChanged = false;

  for (const [slug, app] of desired) {
    const cur = running.get(slug);
    if (!cur || cur.hash !== app.hash || cur.port !== String(app.port)) {
      startApp(slug, app);
    } else if (cur.state !== 'running') {
      try { docker(['start', cur.name]); log(`restarted ${cur.name}`); } catch {}
    }
    routesChanged = writeRoute(slug, app.port) || routesChanged;
  }

  for (const [slug, cur] of running) {
    if (!desired.has(slug)) {
      dockerQuiet(['rm', '-f', cur.name]);
      log(`removed ${cur.name} (manifest gone)`);
      if (fs.existsSync(routeFile(slug))) { fs.unlinkSync(routeFile(slug)); routesChanged = true; }
    }
  }

  // Prune orphaned route files (app removed while deployer was down).
  for (const f of fs.readdirSync(ROUTES)) {
    if (!f.endsWith('.caddy') || f === '00-placeholder.caddy') continue;
    const slug = f.slice(0, -'.caddy'.length);
    if (!desired.has(slug)) { fs.unlinkSync(path.join(ROUTES, f)); routesChanged = true; }
  }

  if (routesChanged) reloadGateway();
  writeStatus(desired, runningApps());
}

/* ------------------------------------------------------------------------- *
 * Admin plane (opt-in via DOCKLETS_ADMIN_PORT, e.g. 2020).
 *
 * Threat model (see SECURITY.md, "Admin plane"): deployed apps and agents are
 * assumed hostile. Defenses, in order of appearance below:
 *  - bearer token stored OUTSIDE the asset root (agents can never read it),
 *    0600, generated once, compared in constant time
 *  - binds 127.0.0.1 only; strict Host-header allowlist kills DNS rebinding
 *  - no cookies and no CORS headers: cross-origin browser access is dead on
 *    arrival, and the bearer header forces a preflight that is never granted
 *  - actions are lifecycle-only (restart, pause, resume, logs); deploying and
 *    deleting remain filesystem operations, never HTTP ones
 *  - failures never take the converge loop down; unreadable token fails closed
 * ------------------------------------------------------------------------- */

const ADMIN_TOKEN_DIR = path.join(os.homedir(), '.config', 'docklets');
const ADMIN_TOKEN_FILE = path.join(ADMIN_TOKEN_DIR, 'admin-token');
let lastAuthFailLog = 0;

function ensureAdminToken() {
  fs.mkdirSync(ADMIN_TOKEN_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(ADMIN_TOKEN_FILE)) {
    const tmp = ADMIN_TOKEN_FILE + '.tmp';
    fs.writeFileSync(tmp, 'dkadm_' + randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, ADMIN_TOKEN_FILE);
    log(`admin token generated at ${ADMIN_TOKEN_FILE}`);
  }
}

function checkAuth(req) {
  let stored;
  try { stored = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim(); } catch { return 'unavailable'; }
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = createHash('sha256').update(stored).digest();
  const b = createHash('sha256').update(given).digest();
  if (given && timingSafeEqual(a, b)) return 'ok';
  const now = Date.now();
  if (now - lastAuthFailLog > 60_000) { lastAuthFailLog = now; log('admin: rejected unauthorized request(s)'); }
  return 'bad';
}

function adminSlugState(slug) {
  if (!SLUG_RE.test(slug)) return null;
  const dir = path.join(ROOT, slug);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return null;
  return { manifest: fs.existsSync(path.join(dir, 'app.json')), paused: isPaused(slug) };
}

function adminStatus() {
  const desired = desiredApps();
  const running = runningApps();
  const apps = [];
  for (const [slug, app] of desired) {
    const cur = running.get(slug);
    apps.push({ slug, runtime: app.runtime, port: app.port, hash: app.hash,
      state: cur?.state ?? 'starting', statusText: cur?.statusText ?? '' });
  }
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isDirectory() && SLUG_RE.test(e.name) && !desired.has(e.name) && isPaused(e.name)) {
      apps.push({ slug: e.name, state: 'paused', statusText: 'paused (manifest set aside)' });
    }
  }
  const statics = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG_RE.test(e.name) && !desired.has(e.name) && !isPaused(e.name))
    .map((e) => e.name);
  return { generatedAt: new Date().toISOString(), apps, static: statics };
}

function adminAction(action, slug) {
  const st = adminSlugState(slug);
  if (!st) return { code: 404, body: { error: 'unknown slug' } };
  const manifest = path.join(ROOT, slug, 'app.json');
  const parked = path.join(ROOT, slug, 'app.json.paused');
  if (action === 'restart') {
    if (!st.manifest) return { code: 409, body: { error: 'not a running app' } };
    dockerQuiet(['restart', PREFIX + slug]);
    return { code: 200, body: { ok: true } };
  }
  if (action === 'pause') {
    if (!st.manifest) return { code: 409, body: { error: 'no manifest to pause' } };
    if (st.paused) return { code: 409, body: { error: 'app.json.paused already exists' } };
    fs.renameSync(manifest, parked);
    return { code: 200, body: { ok: true, note: 'container is removed on the next converge pass' } };
  }
  if (action === 'resume') {
    if (!st.paused) return { code: 409, body: { error: 'not paused' } };
    if (st.manifest) return { code: 409, body: { error: 'app.json already exists' } };
    fs.renameSync(parked, manifest);
    return { code: 200, body: { ok: true } };
  }
  return { code: 404, body: { error: 'unknown action' } };
}

function adminLogs(slug, tail) {
  if (!adminSlugState(slug)) return { code: 404, body: { error: 'unknown slug' } };
  const n = Math.min(Math.max(Number(tail) || 100, 1), 500);
  const r = spawnSync('docker', ['logs', '--tail', String(n), PREFIX + slug],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (r.status !== 0) return { code: 404, body: { error: 'no container for slug' } };
  return { code: 200, body: { logs: (r.stdout + r.stderr).slice(-256 * 1024) } };
}

function startAdmin() {
  ensureAdminToken();
  let ui = '';
  try { ui = fs.readFileSync(new URL('./admin-ui.html', import.meta.url), 'utf8'); } catch {}
  const hostOk = new Set([`127.0.0.1:${ADMIN_PORT}`, `localhost:${ADMIN_PORT}`]);
  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (!hostOk.has(req.headers.host || '')) return send(403, { error: 'bad host' });
    const u = new URL(req.url, `http://127.0.0.1:${ADMIN_PORT}`);
    if (req.method === 'GET' && u.pathname === '/') return send(200, ui || 'admin UI missing', 'text/html; charset=utf-8');
    const auth = checkAuth(req);
    if (auth === 'unavailable') return send(503, { error: 'token unreadable, failing closed' });
    if (auth !== 'ok') return send(401, { error: 'unauthorized' });
    const act = u.pathname.match(/^\/api\/(restart|pause|resume)\/([a-z0-9-]{1,41})$/);
    if (req.method === 'GET' && u.pathname === '/api/status') return send(200, adminStatus());
    if (req.method === 'GET') {
      const lm = u.pathname.match(/^\/api\/logs\/([a-z0-9-]{1,41})$/);
      if (lm) { const r = adminLogs(lm[1], u.searchParams.get('tail')); return send(r.code, r.body); }
    }
    if (req.method === 'POST' && act) { const r = adminAction(act[1], act[2]); return send(r.code, r.body); }
    return send(req.method === 'GET' || req.method === 'POST' ? 404 : 405, { error: 'no such route' });
  });
  server.on('error', (e) => log('admin plane disabled:', String(e.message || e)));
  server.listen(ADMIN_PORT, '127.0.0.1', () =>
    log(`admin plane on http://127.0.0.1:${ADMIN_PORT} (token: ${ADMIN_TOKEN_FILE})`));
}

if (!fs.existsSync(ROOT)) { console.error(`DOCKLETS_ROOT does not exist: ${ROOT}`); process.exit(1); }
fs.mkdirSync(ROUTES, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const placeholder = path.join(ROUTES, '00-placeholder.caddy');
if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, '# placeholder so the routes glob always matches\n');
if (DRIVER === 'docker') dockerQuiet(['network', 'create', NET]);

log(`docklets deployer starting; root=${ROOT} net=${NET} gateway=${GATEWAY}${ONCE ? ' (single pass)' : ''}`);
if (ADMIN_PORT) startAdmin();
do {
  try { converge(); } catch (e) { log('converge error:', String(e.message || e).split('\n')[0]); }
  if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS));
} while (!ONCE);
