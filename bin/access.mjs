#!/usr/bin/env node
/**
 * docklets access service: makes a slug private when it holds an access.json.
 *
 * The gateway asks this service about every request under a top-level name
 * (Caddy forward_auth: GET /check?slug=<name>, original method and URI in
 * X-Forwarded-Method / X-Forwarded-Uri) and routes /.docklets/access/* here:
 * the login page, password unlock, and secret-link redeem. This service reads
 * each policy itself, so file modes or what the gateway can see never change
 * an answer; without it, the gateway fails closed. The decision itself lives
 * in access-core.mjs.
 *
 * Configuration (env):
 *   DOCKLETS_ROOT                  asset root                      (default: $PWD)
 *   DOCKLETS_ACCESS_ADDR           listen address                  (default: 127.0.0.1)
 *   DOCKLETS_ACCESS_PORT           listen port                     (default: 9100)
 *   DOCKLETS_ACCESS_KEY_FILE       cookie signing key, created once (default: <root>/.gateway/access-key)
 *   DOCKLETS_ACCESS_SECURE         Secure cookies: auto | 1 | 0    (default: auto)
 *   DOCKLETS_ACCESS_CLIENT_HEADER  header naming the visitor for failure limits
 *                                  (default: first X-Forwarded-For entry)
 *   DOCKLETS_ACCESS_MAX_FAILS      failed attempts per client per 10 minutes (default: 10)
 *   DOCKLETS_ACCESS_MAX_VERIFIES   concurrent password checks      (default: 2)
 *
 * CLI (writes <root>/<slug>/access.json; secrets are printed once, stored hashed):
 *   node access.mjs link <slug> [--label TEXT] [--expires 30m|12h|7d]
 *   node access.mjs password <slug> [--generate | --clear]   (password on stdin)
 *   node access.mjs revoke <slug> <link-id>
 *   node access.mjs public <slug>
 *   node access.mjs list
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePolicy, decide, mintCookie, cookieName, safeReturn, loginLocation, secureFor,
  importAccessKey, newLinkToken, newLinkId, generatePassword, linkPath, sha256b64url,
} from './access-core.mjs';
import { scryptHash, scryptVerifyAsync } from './sync-common.mjs';

const ROOT = path.resolve(process.env.DOCKLETS_ROOT || process.cwd());
const ADDR = process.env.DOCKLETS_ACCESS_ADDR || '127.0.0.1';
const PORT = Number(process.env.DOCKLETS_ACCESS_PORT ?? 9100);
const KEY_FILE = process.env.DOCKLETS_ACCESS_KEY_FILE || path.join(ROOT, '.gateway', 'access-key');
const SECURE = process.env.DOCKLETS_ACCESS_SECURE || 'auto';
const CLIENT_HEADER = (process.env.DOCKLETS_ACCESS_CLIENT_HEADER || '').toLowerCase();
const MAX_FAILS = Number(process.env.DOCKLETS_ACCESS_MAX_FAILS || 10);
const MAX_VERIFIES = Number(process.env.DOCKLETS_ACCESS_MAX_VERIFIES || 2);
const FAIL_WINDOW_MS = 10 * 60_000;
const MAX_BODY = 4096;
const ACCESS_FILE = 'access.json';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const TOKEN_RE = /^dkl_[A-Za-z0-9_-]{43}$/;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------------- *
 * Policy files
 * ------------------------------------------------------------------------- */

const policyCache = new Map();

/**
 * { public: true } | { policy } | { error }, for the top-level name `seg`
 * (a slug folder, or a root file whose path has no access.json under it).
 * A file that is not a plain regular file, or that cannot be read, is an error.
 */
function loadPolicy(seg) {
  const p = path.join(ROOT, seg, ACCESS_FILE);
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    return e.code === 'ENOENT' || e.code === 'ENOTDIR' ? { public: true } : { error: 'unreadable' };
  }
  if (!st.isFile()) return { error: 'not a regular file' };
  const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const hit = policyCache.get(seg);
  if (hit && hit.stamp === stamp) return hit.result;
  let result;
  try {
    const r = parsePolicy(fs.readFileSync(p, 'utf8'));
    result = r.ok ? { policy: r.policy } : { error: r.error };
  } catch { result = { error: 'unreadable' }; }
  if (result.error) log(`${seg}/${ACCESS_FILE} is invalid (${result.error}); it stays closed`);
  policyCache.set(seg, { stamp, result });
  return result;
}

/* ------------------------------------------------------------------------- *
 * Cookie signing key: 32 random bytes, created once, never served or synced
 * ------------------------------------------------------------------------- */

let keyPromise = null;

function accessKey() {
  if (!keyPromise) keyPromise = loadKey().catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}

async function loadKey() {
  let bytes;
  try { bytes = fs.readFileSync(KEY_FILE); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(KEY_FILE, randomBytes(32), { mode: 0o600, flag: 'wx' });
      log(`access key created at ${KEY_FILE}`);
    } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    bytes = fs.readFileSync(KEY_FILE);
  }
  if (bytes.length < 32) throw new Error('access key is shorter than 32 bytes');
  return importAccessKey(bytes);
}

/* ------------------------------------------------------------------------- *
 * Failure limits and the password-check cap
 * ------------------------------------------------------------------------- */

const fails = new Map();
let verifying = 0;

function clientOf(req) {
  const raw = (CLIENT_HEADER && req.headers[CLIENT_HEADER]) || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  return String(raw).split(',')[0].trim();
}

function limited(who) {
  const f = fails.get(who);
  return !!f && f.until > Date.now() && f.n >= MAX_FAILS;
}

function recordFailure(who) {
  const now = Date.now();
  if (fails.size > 10_000) for (const [k, f] of fails) if (f.until <= now) fails.delete(k);
  const f = fails.get(who);
  if (!f || f.until <= now) fails.set(who, { n: 1, until: now + FAIL_WINDOW_MS });
  else f.n++;
}

/* ------------------------------------------------------------------------- *
 * HTTP
 * ------------------------------------------------------------------------- */

function send(res, code, body = '', headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

const redirect = (res, location, headers = {}) => send(res, 303, '', { Location: location, ...headers });
const loginWith = (slug, ret, e) => `${loginLocation(slug, ret)}&e=${e}`;

function readForm(req) {
  return new Promise((resolve) => {
    if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers['content-type'] || '')) {
      req.resume(); return resolve({ code: 415 });
    }
    let size = 0, body = '', over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { size += Buffer.byteLength(c); if (size > MAX_BODY) over = true; else body += c; });
    req.on('end', () => resolve(over ? { code: 413 } : { form: new URLSearchParams(body) }));
    req.on('error', () => resolve({ code: 400 }));
  });
}

async function setCookieFor(req, slug, cred, policy) {
  const now = nowSec();
  const value = await mintCookie(await accessKey(), slug, cred, policy, now);
  if (!value) return null;
  const maxAge = Number(value.split('.')[2]) - now;
  const secure = secureFor(SECURE, req.headers['x-forwarded-host'] || req.headers.host, req.headers['x-forwarded-proto']);
  return `${cookieName(slug)}=${value}; Path=/${slug}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// The gateway asks about every request under a top-level name, so the
// decision never depends on what the gateway itself can see or read.
async function check(req, res, u) {
  const slug = u.searchParams.get('slug') || '';
  if (!slug || slug.includes('/') || slug === '.' || slug === '..') return send(res, 403, 'forbidden');
  const st = loadPolicy(slug);
  if (st.public) return send(res, 200);
  // On a case-insensitive disk /CASEY/ finds casey's policy: a case variant
  // of a slug is simply not found.
  if (!SLUG_RE.test(slug) && SLUG_RE.test(slug.toLowerCase())) return send(res, 404, 'not found\n');
  if (st.error || !SLUG_RE.test(slug)) return sendPage(res, 503, invalidPage());
  let key;
  try { key = await accessKey(); } catch (e) {
    log(`access key unavailable (${e.message}); private slugs stay closed`);
    return sendPage(res, 503, invalidPage());
  }
  const d = await decide({ policy: st.policy, slug, key, now: nowSec(),
    method: req.headers['x-forwarded-method'] || 'GET', accept: req.headers.accept,
    cookieHeader: req.headers.cookie, authorization: req.headers.authorization });
  // The gateway copies X-Docklets-Access onto the request and marks the
  // response Cache-Control: private when it says so.
  if (d.action === 'allow') return send(res, 200, '', { 'X-Docklets-Access': 'private' });
  if (d.action === 'login') return redirect(res, loginLocation(slug, req.headers['x-forwarded-uri']));
  return send(res, 401, 'this docklet is private\n', { 'WWW-Authenticate': 'Bearer realm="docklets"' });
}

async function unlockOrRedeem(req, res, kind) {
  const r = await readForm(req);
  if (!r.form) return send(res, r.code);
  const slug = r.form.get('slug') || '';
  if (!SLUG_RE.test(slug)) return send(res, 400, 'bad slug');
  const ret = safeReturn(slug, r.form.get('return'));
  const st = loadPolicy(slug);
  if (st.public) return redirect(res, ret);
  if (st.error) return sendPage(res, 503, invalidPage());
  // Only password guesses count toward the failure limit. A link token has
  // 256 bits; counting failed redeems would only let anyone sharing a
  // visitor's address lock them out.
  const who = clientOf(req);
  if (kind === 'unlock' && limited(who)) return redirect(res, loginWith(slug, ret, 'limit'));

  let cred = null;
  if (kind === 'unlock') {
    const pw = r.form.get('password') || '';
    if (st.policy.password && pw.length >= 1 && pw.length <= 128) {
      if (verifying >= MAX_VERIFIES) return redirect(res, loginWith(slug, ret, 'busy'));
      verifying++;
      try { if (await scryptVerifyAsync(pw, st.policy.password)) cred = 'pw'; } finally { verifying--; }
    }
  } else {
    const token = r.form.get('token') || '';
    if (TOKEN_RE.test(token)) {
      const h = await sha256b64url(token);
      const now = nowSec();
      cred = st.policy.links.find((l) => l.hash === h && (l.exp === null || l.exp > now))?.id ?? null;
    }
  }
  if (!cred) {
    if (kind === 'unlock') recordFailure(who);
    return redirect(res, loginWith(slug, ret, kind === 'unlock' ? 'password' : 'link'));
  }
  const cookie = await setCookieFor(req, slug, cred, st.policy);
  if (!cookie) return redirect(res, loginWith(slug, ret, 'link'));
  return redirect(res, ret, { 'Set-Cookie': cookie });
}

/* ------------------------------------------------------------------------- *
 * Pages: self-contained, system colors (light and dark), one hashed script
 * ------------------------------------------------------------------------- */

// Redeems a secret link: the token arrives in the fragment (carried across the
// gateway's redirect), is posted once, and is wiped from the address bar.
const SCRIPT = "(function(){var h=location.hash;if(h.indexOf('#dkl_')!==0)return;" +
  "var f=document.getElementById('redeem');f.elements.token.value=h.slice(1);" +
  "history.replaceState(null,'',location.pathname+location.search);f.submit();})();";
const SCRIPT_HASH = createHash('sha256').update(SCRIPT).digest('base64');
const CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; ` +
  `form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const MESSAGES = {
  password: "That password didn't work.",
  link: 'That link is not valid, or it has expired or been revoked.',
  limit: 'Too many attempts. Try again in a few minutes.',
  busy: 'Busy right now. Try again in a moment.',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(title, inner) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<main style="padding:2rem 1.5rem;width:100%;max-width:22rem;box-sizing:border-box">
${inner}
<p style="margin:1.6rem 0 0;font-size:.82rem;opacity:.5;text-align:center">served by docklets</p>
</main>
</body>
</html>
`;
}

function loginPage(slug, ret, policy, e) {
  const msg = Object.hasOwn(MESSAGES, e ?? '') ? `<p role="alert" style="margin:.8rem 0 0;line-height:1.5;font-weight:600">${esc(MESSAGES[e])}</p>` : '';
  const hidden = `<input type="hidden" name="slug" value="${esc(slug)}"><input type="hidden" name="return" value="${esc(ret)}">`;
  const form = policy.password
    ? `<form method="post" action="/.docklets/access/unlock" style="margin:1.2rem 0 0;display:grid;gap:.6rem">${hidden}
<label for="pw" style="font-size:.9rem;opacity:.8">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus style="font:inherit;padding:.55rem .7rem;border:1px solid GrayText;border-radius:.4rem;background:Field;color:FieldText">
<button type="submit" style="font:inherit;padding:.55rem .7rem;border:0;border-radius:.4rem;background:AccentColor;color:AccentColorText;cursor:pointer">Open</button>
</form>`
    : '<p style="margin:.8rem 0 0;line-height:1.55;opacity:.72">Ask its owner for a link.</p>';
  return shell('Private docklet', `<h1 style="font-size:1.3rem;margin:0">This docklet is private</h1>
${msg}
${form}
<form id="redeem" method="post" action="/.docklets/access/redeem" hidden>${hidden}<input type="hidden" name="token"></form>
<script>${SCRIPT}</script>`);
}

function invalidPage() {
  return shell('Private docklet', `<h1 style="font-size:1.3rem;margin:0">This docklet is closed</h1>
<p style="margin:.8rem 0 0;line-height:1.55;opacity:.72">Its access settings can't be read right now, so it stays closed. If it's yours, check its access.json.</p>`);
}

function sendPage(res, code, html) {
  send(res, code, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer' });
}

function login(req, res, u) {
  const slug = u.searchParams.get('slug') || '';
  if (!SLUG_RE.test(slug)) return send(res, 400, 'bad slug');
  const ret = safeReturn(slug, u.searchParams.get('return'));
  const st = loadPolicy(slug);
  if (st.public) return redirect(res, ret);
  if (st.error) return sendPage(res, 503, invalidPage());
  return sendPage(res, 200, loginPage(slug, ret, st.policy, u.searchParams.get('e')));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://access');
  if (req.method === 'GET' && u.pathname === '/check') return check(req, res, u);
  if ((req.method === 'GET' || req.method === 'HEAD') && u.pathname === '/.docklets/access/login') return login(req, res, u);
  if (req.method === 'POST' && u.pathname === '/.docklets/access/unlock') return unlockOrRedeem(req, res, 'unlock');
  if (req.method === 'POST' && u.pathname === '/.docklets/access/redeem') return unlockOrRedeem(req, res, 'redeem');
  return send(res, 404, 'not found\n');
}

function serve() {
  accessKey().catch((e) => log(`access key unavailable (${e.message}); private slugs stay closed until it is`));
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('request error:', String(e.message || e));
      if (!res.headersSent) send(res, 503, 'unavailable\n');
    });
  });
  server.listen(PORT, ADDR, () => {
    const a = server.address();
    console.log(`access listening on http://${a.address}:${a.port} (root ${ROOT})`);
  });
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function die(msg) { console.error(msg); process.exit(1); }

function slugDir(slug) {
  if (!SLUG_RE.test(slug || '')) die(`not a slug: ${slug}`);
  const dir = path.join(ROOT, slug);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) die(`no such docklet: ${dir}`);
  return dir;
}

function readPolicyForEdit(slug) {
  const p = path.join(slugDir(slug), ACCESS_FILE);
  if (!fs.existsSync(p)) return { password: null, links: [] };
  const r = parsePolicy(fs.readFileSync(p, 'utf8'));
  if (!r.ok) die(`${slug}/${ACCESS_FILE} is invalid (${r.error}); fix or remove it first`);
  return r.policy;
}

function writePolicy(slug, policy) {
  const now = nowSec();
  const doc = { v: 1 };
  if (policy.password) doc.password = policy.password;
  doc.links = policy.links.filter((l) => l.exp === null || l.exp > now).map((l) => ({
    id: l.id, hash: l.hash,
    ...(l.label ? { label: l.label } : {}),
    ...(l.exp !== null ? { exp: new Date(l.exp * 1000).toISOString() } : {}),
  }));
  const dir = slugDir(slug);
  const tmp = path.join(dir, `.${ACCESS_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, ACCESS_FILE));
}

function parseDuration(s) {
  const m = /^(\d{1,4})([mhd])$/.exec(s || '');
  if (!m) die(`bad --expires "${s}": use e.g. 30m, 12h, 7d`);
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]];
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`);
  return v;
}

function readSecretLine(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve(fs.readFileSync(0, 'utf8').replace(/\r?\n$/, ''));
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    let s = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
        process.stderr.write('\n'); return resolve(s);
      }
      if (ch === '\u007f' || ch === '\b') { s = s.slice(0, -1); return; }
      s += ch;
    };
    process.stdin.on('data', onData);
  });
}

async function cli(cmd, args) {
  const slug = args[0];
  if (cmd === 'list') {
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !SLUG_RE.test(e.name)) continue;
      const st = loadPolicy(e.name);
      if (st.public) continue;
      if (st.error) { console.log(`${e.name.padEnd(24)} invalid (${st.error})`); continue; }
      const ids = st.policy.links.map((l) => l.id + (l.label ? ` "${l.label}"` : '')).join(', ');
      console.log(`${e.name.padEnd(24)} private  password:${st.policy.password ? 'yes' : 'no'}  links:${st.policy.links.length}${ids ? `  (${ids})` : ''}`);
    }
    return;
  }
  if (cmd === 'link') {
    const policy = readPolicyForEdit(slug);
    const label = flag(args, '--label');
    const expires = flag(args, '--expires');
    const exp = expires ? nowSec() + parseDuration(expires) : null;
    const { token, hash } = await newLinkToken();
    let id;
    do { id = newLinkId(); } while (policy.links.some((l) => l.id === id));
    policy.links.push({ id, hash, label: label ? label.slice(0, 80) : null, exp });
    writePolicy(slug, policy);
    const base = (process.env.DOCKLETS_PUBLIC_URL || '').replace(/\/+$/, '');
    console.log(`private link for ${slug} (id ${id}${exp ? `, expires ${new Date(exp * 1000).toISOString()}` : ''}):`);
    console.log(`  ${base}${linkPath(slug, token)}`);
    if (!base) console.log('  (prefix it with your gateway address, or set DOCKLETS_PUBLIC_URL)');
    console.log(`Shown once: anyone with this link can open the docklet. Revoke: access.mjs revoke ${slug} ${id}`);
    return;
  }
  if (cmd === 'password') {
    const policy = readPolicyForEdit(slug);
    if (args.includes('--clear')) {
      policy.password = null;
      writePolicy(slug, policy);
      console.log(`${slug}: password removed (it stays private; links still open it)`);
      return;
    }
    let pw;
    if (args.includes('--generate')) pw = generatePassword();
    else {
      pw = await readSecretLine('password: ');
      if (pw.length < 8 || pw.length > 128) die('a password needs 8 to 128 characters');
    }
    policy.password = scryptHash(pw);
    writePolicy(slug, policy);
    console.log(args.includes('--generate') ? `password for ${slug}: ${pw}` : `${slug}: password set`);
    return;
  }
  if (cmd === 'revoke') {
    const policy = readPolicyForEdit(slug);
    const id = args[1];
    if (!policy.links.some((l) => l.id === id)) die(`${slug} has no link with id ${id}`);
    policy.links = policy.links.filter((l) => l.id !== id);
    writePolicy(slug, policy);
    console.log(`${slug}: link ${id} revoked`);
    return;
  }
  if (cmd === 'public') {
    const p = path.join(slugDir(slug), ACCESS_FILE);
    if (!fs.existsSync(p)) { console.log(`${slug} is already public`); return; }
    fs.unlinkSync(p);
    console.log(`${slug} is public now`);
  }
}

const CMDS = new Set(['link', 'password', 'revoke', 'public', 'list']);
const [cmd, ...rest] = process.argv.slice(2);
if (cmd && CMDS.has(cmd)) await cli(cmd, rest);
else if (cmd) die(`unknown command "${cmd}" (link | password | revoke | public | list)`);
else serve();
