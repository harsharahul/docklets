import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptHash } from '../bin/sync-common.mjs';
import { newLinkToken, parsePolicy } from '../bin/access-core.mjs';

const ACCESS = new URL('../bin/access.mjs', import.meta.url).pathname;
let root, keyFile, base, child, clientN = 0;

// Every test speaks as its own client so failure limits never bleed across tests.
const client = () => `test-client-${clientN++}`;

async function spawnAccess(env) {
  const proc = spawn(process.execPath, [ACCESS], {
    env: { ...process.env, DOCKLETS_ACCESS_PORT: '0', ...env },
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/access listening on (http:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (c) => reject(new Error(`access exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
  });
  return { proc, url };
}

function slug(name, policy) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'index.html'), `<h1>${name}</h1>`);
  if (policy !== undefined) {
    fs.writeFileSync(path.join(root, name, 'access.json'), typeof policy === 'string' ? policy : JSON.stringify(policy));
  }
}

const check = (s, { uri = `/${s}/`, method = 'GET', accept = 'text/html', cookie, authorization } = {}) =>
  fetch(`${base}/check?slug=${s}`, {
    redirect: 'manual',
    headers: { 'x-forwarded-uri': uri, 'x-forwarded-method': method, accept,
      ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  });

const post = (p, fields, { who = client(), host = '127.0.0.1:8080', type = 'application/x-www-form-urlencoded' } = {}) =>
  fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': type, 'x-test-client': who, 'x-forwarded-host': host },
    body: typeof fields === 'string' ? fields : new URLSearchParams(fields).toString(),
  });

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

function cli(args, { input, env } = {}) {
  return spawnSync(process.execPath, [ACCESS, ...args], {
    encoding: 'utf8', input,
    env: { ...process.env, DOCKLETS_ROOT: root, DOCKLETS_ACCESS_KEY_FILE: keyFile, ...env },
  });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-access-'));
  keyFile = path.join(root, '.gateway', 'access-key');
  ({ proc: child, url: base } = await spawnAccess({
    DOCKLETS_ROOT: root, DOCKLETS_ACCESS_KEY_FILE: keyFile,
    DOCKLETS_ACCESS_CLIENT_HEADER: 'x-test-client', DOCKLETS_ACCESS_MAX_FAILS: '3',
    DOCKLETS_ACCESS_MAX_VERIFIES: '1',
  }));
});
after(() => child.kill());

test('a public slug passes the check and is not marked private', async () => {
  slug('pub');
  const r = await check('pub');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-docklets-access'), null);
});

test('root files and missing folders pass the check', async () => {
  fs.writeFileSync(path.join(root, '404.html'), 'nf');
  assert.equal((await check('404.html')).status, 200);
  assert.equal((await check('.status.json')).status, 200);
  assert.equal((await check('no-such-folder')).status, 200);
});

test('a policy the service cannot read keeps the slug closed', async () => {
  slug('unreadable', { v: 1 });
  fs.chmodSync(path.join(root, 'unreadable', 'access.json'), 0o000);
  try {
    if (process.getuid() !== 0) assert.equal((await check('unreadable')).status, 503);
  } finally { fs.chmodSync(path.join(root, 'unreadable', 'access.json'), 0o600); }
});

test('a policy in a folder that is not a slug keeps it closed', async () => {
  fs.mkdirSync(path.join(root, 'not.a.slug'), { recursive: true });
  fs.writeFileSync(path.join(root, 'not.a.slug', 'access.json'), '{"v":1}');
  assert.equal((await check('not.a.slug')).status, 503);
});

test('a page load of a private slug goes to the login page, uncached', async () => {
  slug('draft1', { v: 1 });
  const r = await check('draft1', { uri: '/draft1/notes/a.html?x=1' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/.docklets/access/login?slug=draft1&return=%2Fdraft1%2Fnotes%2Fa.html%3Fx%3D1');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('a non-page request to a private slug is denied with 401', async () => {
  slug('draft2', { v: 1 });
  for (const opts of [{ method: 'POST' }, { accept: 'application/json' }]) {
    const r = await check('draft2', opts);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
});

test('an access.json the parser rejects fails closed', async () => {
  slug('broken', '{"v":1,"password":"plaintext"}');
  assert.equal((await check('broken')).status, 503);
  slug('linked', { v: 1 });
  fs.rmSync(path.join(root, 'linked', 'access.json'));
  fs.symlinkSync(path.join(root, 'draft1', 'access.json'), path.join(root, 'linked', 'access.json'));
  assert.equal((await check('linked')).status, 503, 'symlinked policy');
});

test('a case variant of a private slug is not found, never served', async () => {
  slug('casey', { v: 1 });
  const caseInsensitiveFs = fs.existsSync(path.join(root, 'CASEY', 'access.json'));
  const r = await check('CASEY');
  assert.equal(r.status, caseInsensitiveFs ? 404 : 200, 'on a case-sensitive disk there is simply nothing at CASEY');
  assert.equal(r.headers.get('x-docklets-access'), null);
});

test('a segment that is not a single path name is refused', async () => {
  for (const s of ['..', '.', 'a%2Fb', '']) assert.equal((await check(s)).status, 403, s);
});

test('the right password sets a slug-scoped cookie the check accepts', async () => {
  slug('pw', { v: 1, password: scryptHash('correct horse') });
  const r = await post('/.docklets/access/unlock', { slug: 'pw', password: 'correct horse', return: '/pw/deep/page.html' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/pw/deep/page.html');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /^dk_access_pw=v1\.pw\.\d+\.[A-Za-z0-9_-]+; Path=\/pw; Max-Age=604800; HttpOnly; SameSite=Lax$/);
  const ok = await check('pw', { cookie: cookieOf(r) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-docklets-access'), 'private', 'the gateway marks the response private from this');
  assert.equal((await check('draft1', { cookie: cookieOf(r).replace('dk_access_pw', 'dk_access_draft1') })).status, 303, 'not valid for another slug');
});

test('a wrong password returns to the login page and sets no cookie', async () => {
  slug('pw2', { v: 1, password: scryptHash('right') });
  const r = await post('/.docklets/access/unlock', { slug: 'pw2', password: 'wrong', return: '/pw2/' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/.docklets/access/login?slug=pw2&return=%2Fpw2%2F&e=password');
  assert.equal(r.headers.get('set-cookie'), null);
});

test('an open redirect in return is replaced by the slug root', async () => {
  slug('pw3', { v: 1, password: scryptHash('right') });
  const r = await post('/.docklets/access/unlock', { slug: 'pw3', password: 'right', return: '//evil.example/' });
  assert.equal(r.headers.get('location'), '/pw3/');
});

test('a secret link token redeems into a cookie for that link', async () => {
  const { token, hash } = await newLinkToken();
  slug('linkd', { v: 1, links: [{ id: 'aaa111', hash }] });
  const r = await post('/.docklets/access/redeem', { slug: 'linkd', token, return: '/linkd/' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/linkd/');
  assert.match(cookieOf(r), /^dk_access_linkd=v1\.aaa111\./);
  assert.equal((await check('linkd', { cookie: cookieOf(r) })).status, 200);
  const bad = await post('/.docklets/access/redeem', { slug: 'linkd', token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), return: '/linkd/' });
  assert.equal(bad.headers.get('location'), '/.docklets/access/login?slug=linkd&return=%2Flinkd%2F&e=link');
  assert.equal(bad.headers.get('set-cookie'), null);
});

test('a dkl_ bearer token passes the check without a cookie', async () => {
  const { token, hash } = await newLinkToken();
  slug('api', { v: 1, links: [{ id: 'api001', hash }] });
  assert.equal((await check('api', { method: 'POST', accept: '*/*', authorization: `Bearer ${token}` })).status, 200);
});

test('failed link redeems never lock anyone out', async () => {
  const { token, hash } = await newLinkToken();
  slug('nolock', { v: 1, links: [{ id: 'nol001', hash }] });
  const who = client();
  for (let i = 0; i < 5; i++) await post('/.docklets/access/redeem', { slug: 'nolock', token: 'dkl_' + 'x'.repeat(43), return: '/nolock/' }, { who });
  const r = await post('/.docklets/access/redeem', { slug: 'nolock', token, return: '/nolock/' }, { who });
  assert.equal(r.headers.get('location'), '/nolock/');
});

test('the login page ignores unknown error codes, including inherited names', async () => {
  slug('lpe', { v: 1, password: scryptHash('right') });
  const html = await (await fetch(`${base}/.docklets/access/login?slug=lpe&return=%2Flpe%2F&e=constructor`)).text();
  assert.doesNotMatch(html, /role="alert"/);
});

test('a policy replaced within the same second is reread', async () => {
  slug('fresh', { v: 1, password: scryptHash('first-pass') });
  const p = path.join(root, 'fresh', 'access.json');
  const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(p, t0, t0);
  await check('fresh');
  fs.writeFileSync(p + '.tmp', JSON.stringify({ v: 1, password: scryptHash('other-pass') }));
  fs.utimesSync(p + '.tmp', t0, t0);
  assert.equal(fs.statSync(p + '.tmp').size, fs.statSync(p).size, 'same size, same mtime: only the inode differs');
  fs.renameSync(p + '.tmp', p);
  const r = await post('/.docklets/access/unlock', { slug: 'fresh', password: 'first-pass', return: '/fresh/' });
  assert.equal(r.headers.get('location'), '/.docklets/access/login?slug=fresh&return=%2Ffresh%2F&e=password');
});

test('repeated failures from one client are limited, even before a correct guess', async () => {
  slug('limit', { v: 1, password: scryptHash('right') });
  const who = client();
  for (let i = 0; i < 3; i++) await post('/.docklets/access/unlock', { slug: 'limit', password: 'nope', return: '/limit/' }, { who });
  const r = await post('/.docklets/access/unlock', { slug: 'limit', password: 'right', return: '/limit/' }, { who });
  assert.equal(r.headers.get('location'), '/.docklets/access/login?slug=limit&return=%2Flimit%2F&e=limit');
  assert.equal(r.headers.get('set-cookie'), null);
  const other = await post('/.docklets/access/unlock', { slug: 'limit', password: 'right', return: '/limit/' });
  assert.equal(other.headers.get('location'), '/limit/', 'another client is unaffected');
});

test('concurrent password checks beyond the cap are turned away', async () => {
  slug('busy', { v: 1, password: scryptHash('right') });
  const rs = await Promise.all(Array.from({ length: 6 }, () =>
    post('/.docklets/access/unlock', { slug: 'busy', password: 'right', return: '/busy/' })));
  const locs = rs.map((r) => r.headers.get('location'));
  assert.ok(locs.includes('/busy/'), 'at least one got through');
  assert.ok(locs.includes('/.docklets/access/login?slug=busy&return=%2Fbusy%2F&e=busy'), `none turned away: ${locs}`);
});

test('the Secure flag follows the host', async () => {
  slug('sec', { v: 1, password: scryptHash('right') });
  const pub = await post('/.docklets/access/unlock', { slug: 'sec', password: 'right', return: '/sec/' }, { host: 'alice-blog.docklets.dev' });
  assert.match(pub.headers.get('set-cookie'), /; Secure$/);
  const lan = await post('/.docklets/access/unlock', { slug: 'sec', password: 'right', return: '/sec/' }, { host: '192.168.1.5:8080' });
  assert.doesNotMatch(lan.headers.get('set-cookie'), /Secure/);
});

test('the login page offers the password form only when a password is set, under a strict CSP', async () => {
  slug('lp', { v: 1, password: scryptHash('right') });
  slug('lonly', { v: 1 });
  const withPw = await fetch(`${base}/.docklets/access/login?slug=lp&return=%2Flp%2F&e=password`);
  assert.equal(withPw.status, 200);
  assert.equal(withPw.headers.get('cache-control'), 'no-store');
  assert.match(withPw.headers.get('content-security-policy'), /default-src 'none'; .*script-src 'sha256-[A-Za-z0-9+/=]+'/);
  const html = await withPw.text();
  assert.match(html, /<form[^>]+action="\/\.docklets\/access\/unlock"/);
  assert.match(html, /<input[^>]+name="return"[^>]+value="\/lp\/"/);
  assert.match(html, /That password didn&#39;t work\./);
  const linkOnly = await (await fetch(`${base}/.docklets/access/login?slug=lonly&return=%2Flonly%2F`)).text();
  assert.doesNotMatch(linkOnly, /action="\/\.docklets\/access\/unlock"/);
  assert.match(linkOnly, /action="\/\.docklets\/access\/redeem"/);
});

test('the login page for a slug that is no longer private goes straight back', async () => {
  slug('nowpub');
  const r = await fetch(`${base}/.docklets/access/login?slug=nowpub&return=%2Fnowpub%2Fx`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/nowpub/x');
});

test('oversized or non-form unlock bodies are refused', async () => {
  slug('big', { v: 1, password: scryptHash('right') });
  assert.equal((await post('/.docklets/access/unlock', 'slug=big&password=' + 'x'.repeat(5000))).status, 413);
  assert.equal((await post('/.docklets/access/unlock', '{"slug":"big"}', { type: 'application/json' })).status, 415);
});

test('the service creates its key once, readable only by its owner', () => {
  const st = fs.statSync(keyFile);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.size, 32);
});

test('cli link creates a hashed link and prints a fragment link that redeems', async () => {
  slug('clilink');
  const r = cli(['link', 'clilink', '--label', 'for Acme', '--expires', '7d']);
  assert.equal(r.status, 0, r.stderr);
  const token = r.stdout.match(/\/clilink\/#(dkl_[A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token, r.stdout);
  const pol = parsePolicy(fs.readFileSync(path.join(root, 'clilink', 'access.json'), 'utf8'));
  assert.equal(pol.ok, true);
  assert.equal(pol.policy.links.length, 1);
  assert.equal(pol.policy.links[0].label, 'for Acme');
  assert.ok(Math.abs(pol.policy.links[0].exp - (Date.now() / 1000 + 7 * 86400)) < 60);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'clilink', 'access.json'), 'utf8'), new RegExp(token));
  const red = await post('/.docklets/access/redeem', { slug: 'clilink', token, return: '/clilink/' });
  assert.match(cookieOf(red), /^dk_access_clilink=v1\./);
});

test('cli link prints a full URL when the public address is known', () => {
  slug('cliurl');
  const r = cli(['link', 'cliurl'], { env: { DOCKLETS_PUBLIC_URL: 'https://alice-blog.docklets.dev/' } });
  assert.match(r.stdout, /https:\/\/alice-blog\.docklets\.dev\/cliurl\/#dkl_[A-Za-z0-9_-]{43}/);
});

test('cli password reads the password from stdin and keeps existing links', async () => {
  slug('clipw');
  cli(['link', 'clipw']);
  const r = cli(['password', 'clipw'], { input: 'a long passphrase\n' });
  assert.equal(r.status, 0, r.stderr);
  const pol = parsePolicy(fs.readFileSync(path.join(root, 'clipw', 'access.json'), 'utf8')).policy;
  assert.equal(pol.links.length, 1);
  const ok = await post('/.docklets/access/unlock', { slug: 'clipw', password: 'a long passphrase', return: '/clipw/' });
  assert.equal(ok.headers.get('location'), '/clipw/');
  assert.equal(cli(['password', 'clipw'], { input: 'short\n' }).status, 1, 'too short');
});

test('cli password --generate prints a password that unlocks', async () => {
  slug('cligen');
  const r = cli(['password', 'cligen', '--generate']);
  const pw = r.stdout.match(/[a-z2-9]{4}(?:-[a-z2-9]{4}){3}/)?.[0];
  assert.ok(pw, r.stdout);
  const ok = await post('/.docklets/access/unlock', { slug: 'cligen', password: pw, return: '/cligen/' });
  assert.equal(ok.headers.get('location'), '/cligen/');
});

test('cli revoke, list, and public manage a slug end to end', () => {
  slug('climgr');
  const id = cli(['link', 'climgr']).stdout.match(/id ([a-z0-9]{6})/)?.[1];
  assert.ok(id);
  assert.match(cli(['list']).stdout, /climgr\s+private\s+password:no\s+links:1/);
  assert.equal(cli(['revoke', 'climgr', id]).status, 0);
  assert.equal(parsePolicy(fs.readFileSync(path.join(root, 'climgr', 'access.json'), 'utf8')).policy.links.length, 0);
  assert.equal(cli(['revoke', 'climgr', 'nosuch']).status, 1);
  assert.equal(cli(['public', 'climgr']).status, 0);
  assert.equal(fs.existsSync(path.join(root, 'climgr', 'access.json')), false);
});

test('cli refuses unknown slugs and never overwrites an invalid policy', () => {
  assert.equal(cli(['link', 'no-such-slug']).status, 1);
  slug('cliinv', '{"v":99}');
  const r = cli(['link', 'cliinv']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /access\.json/);
  assert.equal(fs.readFileSync(path.join(root, 'cliinv', 'access.json'), 'utf8'), '{"v":99}');
});
