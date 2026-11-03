// The access service for a cell: one folder per tenant under the root, the
// tenant named by a header the gateway sets from the host. Policies, cookie
// keys, and failure limits are per tenant, so nothing one tenant's visitors
// hold or do reaches another tenant's docklets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scryptHash } from '../bin/sync-common.mjs';
import { newLinkToken } from '../bin/access-core.mjs';

const ACCESS = new URL('../bin/access.mjs', import.meta.url).pathname;
let root, base, child, links;
let clientN = 0;
const client = () => `cell-client-${clientN++}`;

function slug(tenant, name, policy) {
  const dir = path.join(root, tenant, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<h1>${tenant}/${name}</h1>`);
  if (policy !== undefined) fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(policy));
}

const check = (tenant, s, { accept = 'text/html', cookie, authorization, noTenant = false } = {}) =>
  fetch(`${base}/check?slug=${s}`, {
    redirect: 'manual',
    headers: { 'x-forwarded-uri': `/${s}/`, 'x-forwarded-method': 'GET', accept,
      ...(noTenant ? {} : { 'x-docklets-tenant': tenant }),
      ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  });

const post = (tenant, p, fields, { who = client() } = {}) =>
  fetch(base + p, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-client': who,
      'x-forwarded-host': `${tenant}.docklets.test`, 'x-docklets-tenant': tenant },
    body: new URLSearchParams(fields).toString(),
  });

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-access-cell-'));
  const a = await newLinkToken();
  const b = await newLinkToken();
  links = { alpha: a.token, bravo: b.token };
  slug('alpha', 'draft', { v: 1, password: scryptHash('alpha-pass'), links: [{ id: 'alp001', hash: a.hash }] });
  slug('bravo', 'draft', { v: 1, password: scryptHash('bravo-pass'), links: [{ id: 'bra001', hash: b.hash }] });
  slug('bravo', 'open');
  child = spawn(process.execPath, [ACCESS], {
    env: { ...process.env, DOCKLETS_ROOT: root, DOCKLETS_ACCESS_MULTI_ROOT: '1', DOCKLETS_ACCESS_PORT: '0',
      DOCKLETS_ACCESS_CLIENT_HEADER: 'x-test-client', DOCKLETS_ACCESS_MAX_FAILS: '3' },
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = out.match(/access listening on (http:\/\/[^\s]+)/); if (m) resolve(m[1]); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error(`access exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
  });
});
after(() => child.kill());

test('each tenant answers from its own folder', async () => {
  assert.equal((await check('alpha', 'draft')).status, 303, "alpha's private draft did not go to login");
  assert.equal((await check('bravo', 'open')).status, 200);
  assert.equal((await check('alpha', 'open')).status, 200, 'a slug a tenant does not have passes (the gateway 404s it)');
  assert.equal((await check('charlie', 'draft')).status, 200, 'a tenant with no folder has nothing private');
});

test('a missing or malformed tenant fails closed', async () => {
  assert.equal((await check('alpha', 'draft', { noTenant: true })).status, 403);
  for (const t of ['../alpha', 'Alpha', 'a/b', '.gateway', 'x'.repeat(50)]) {
    assert.equal((await check(t, 'draft')).status, 403, t);
  }
});

test("a link opens only its own tenant's docklet", async () => {
  const own = await check('alpha', 'draft', { authorization: `Bearer ${links.alpha}`, accept: 'application/json' });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('x-docklets-access'), 'private');
  const other = await check('bravo', 'draft', { authorization: `Bearer ${links.alpha}`, accept: 'application/json' });
  assert.equal(other.status, 401, "alpha's link opened bravo's docklet of the same name");
});

test("a cookie minted for one tenant is worthless on another, even for the same slug", async () => {
  const r = await post('alpha', '/.docklets/access/redeem', { slug: 'draft', token: links.alpha, return: '/draft/' });
  assert.equal(r.status, 303);
  const cookie = cookieOf(r);
  assert.match(cookie, /^dk_access_draft=/);
  assert.equal((await check('alpha', 'draft', { cookie })).status, 200);
  assert.equal((await check('bravo', 'draft', { cookie })).status, 303, "alpha's cookie opened bravo's draft");
  // Each tenant signs with its own key, created in its folder's hidden state.
  const ka = path.join(root, 'alpha', '.gateway', 'access-key');
  const kb = path.join(root, 'bravo', '.gateway', 'access-key');
  await post('bravo', '/.docklets/access/redeem', { slug: 'draft', token: links.bravo, return: '/draft/' });
  assert.ok(fs.existsSync(ka) && fs.existsSync(kb), 'per-tenant keys missing');
  assert.notDeepEqual(fs.readFileSync(ka), fs.readFileSync(kb));
});

test("one tenant's password failures never lock a visitor out of another tenant", async () => {
  const who = client();
  for (let i = 0; i < 3; i++) await post('alpha', '/.docklets/access/unlock', { slug: 'draft', password: 'nope', return: '/draft/' }, { who });
  const locked = await post('alpha', '/.docklets/access/unlock', { slug: 'draft', password: 'alpha-pass', return: '/draft/' }, { who });
  assert.match(locked.headers.get('location'), /e=limit/);
  const elsewhere = await post('bravo', '/.docklets/access/unlock', { slug: 'draft', password: 'bravo-pass', return: '/draft/' }, { who });
  assert.equal(elsewhere.headers.get('location'), '/draft/', 'a limit from alpha applied on bravo');
  assert.match(cookieOf(elsewhere), /^dk_access_draft=/);
});

test('the login page belongs to the tenant it is asked about', async () => {
  const page = await fetch(`${base}/.docklets/access/login?slug=draft&return=%2Fdraft%2F`, { headers: { 'x-docklets-tenant': 'alpha' }, redirect: 'manual' });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /This docklet is private/);
  const none = await fetch(`${base}/.docklets/access/login?slug=open&return=%2Fopen%2F`, { headers: { 'x-docklets-tenant': 'bravo' }, redirect: 'manual' });
  assert.equal(none.status, 303, 'a public slug still offers a login page');
  await none.text();
  const anon = await fetch(`${base}/.docklets/access/login?slug=draft&return=%2Fdraft%2F`, { redirect: 'manual' });
  assert.equal(anon.status, 403);
  await anon.text();
});
