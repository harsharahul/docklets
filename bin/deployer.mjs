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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    '--format', '{{.Names}}\t{{.Label "docklet-hash"}}\t{{.Label "docklet-port"}}\t{{.State}}']);
  const map = new Map();
  for (const line of out ? out.split('\n') : []) {
    const [name, hash, port, state] = line.split('\t');
    map.set(name.slice(PREFIX.length), { name, hash, port, state });
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

function converge() {
  const desired = desiredApps();
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
}

if (!fs.existsSync(ROOT)) { console.error(`DOCKLETS_ROOT does not exist: ${ROOT}`); process.exit(1); }
fs.mkdirSync(ROUTES, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const placeholder = path.join(ROUTES, '00-placeholder.caddy');
if (!fs.existsSync(placeholder)) fs.writeFileSync(placeholder, '# placeholder so the routes glob always matches\n');
dockerQuiet(['network', 'create', NET]);

log(`docklets deployer starting; root=${ROOT} net=${NET} gateway=${GATEWAY}${ONCE ? ' (single pass)' : ''}`);
do {
  try { converge(); } catch (e) { log('converge error:', String(e.message || e).split('\n')[0]); }
  if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS));
} while (!ONCE);
