import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePolicy, sha256b64url, newLinkToken, newLinkId, generatePassword, importAccessKey,
  mintCookie, verifyCookie, decide, safeReturn, readCookie, cookieName, secureFor, linkPath,
} from '../bin/access-core.mjs';

const PW_HASH = 'scrypt$16384$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U';
const LINK = { id: 'k7qm2x', hash: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0' };
const NOW = 1_800_000_000;
const key = await importAccessKey(new Uint8Array(32).fill(7));
const otherKey = await importAccessKey(new Uint8Array(32).fill(8));

const policy = (extra = {}) => parsePolicy(JSON.stringify({ v: 1, password: PW_HASH, links: [LINK], ...extra })).policy;

test('parsePolicy accepts a v1 file with a password and links', () => {
  const r = parsePolicy(JSON.stringify({ v: 1, password: PW_HASH,
    links: [{ ...LINK, label: 'for Acme', exp: '2027-01-01T00:00:00Z' }] }));
  assert.equal(r.ok, true);
  assert.equal(r.policy.password, PW_HASH);
  assert.equal(r.policy.links[0].id, 'k7qm2x');
  assert.equal(r.policy.links[0].exp, Date.parse('2027-01-01T00:00:00Z') / 1000);
});

test('parsePolicy accepts a private file with no way in', () => {
  const r = parsePolicy('{"v":1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.policy.links, []);
  assert.equal(r.policy.password, null);
});

test('parsePolicy rejects anything it cannot fully understand (fail closed)', () => {
  for (const bad of ['', 'not json', '[]', 'null', '{"v":2}', '{}', '{"v":"1"}',
    '{"v":1,"password":"plaintext"}', '{"v":1,"password":5}',
    '{"v":1,"links":{}}', '{"v":1,"links":[{"id":"k7qm2x"}]}',
    '{"v":1,"links":[{"id":"BAD ID","hash":"ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"}]}',
    '{"v":1,"links":[{"id":"k7qm2x","hash":"short"}]}',
    '{"v":1,"links":[{"id":"k7qm2x","hash":"ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0","exp":"soon"}]}',
    '{"v":1,"links":[{"id":"k7qm2x","hash":"ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"},{"id":"k7qm2x","hash":"ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0"}]}']) {
    assert.equal(parsePolicy(bad).ok, false, `accepted: ${bad}`);
  }
});

test('sha256b64url matches the published digest of "abc"', async () => {
  assert.equal(await sha256b64url('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('newLinkToken mints a tagged 256-bit token and its stored hash', async () => {
  const { token, hash } = await newLinkToken();
  assert.match(token, /^dkl_[A-Za-z0-9_-]{43}$/);
  assert.equal(hash, await sha256b64url(token));
  assert.notEqual((await newLinkToken()).token, token);
  assert.match(newLinkId(), /^[a-z0-9]{6}$/);
});

test('generatePassword uses four groups from an unambiguous alphabet', () => {
  const p = generatePassword();
  assert.match(p, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
  assert.notEqual(generatePassword(), p);
});

test('a cookie verifies for its slug and credential', async () => {
  const pol = policy();
  const pw = await mintCookie(key, 'draft', 'pw', pol, NOW);
  assert.equal(await verifyCookie(key, 'draft', pw, pol, NOW + 60), 'pw');
  const ln = await mintCookie(key, 'draft', 'k7qm2x', pol, NOW);
  assert.equal(await verifyCookie(key, 'draft', ln, pol, NOW + 60), 'k7qm2x');
});

test('a cookie is refused when anything it is bound to changes', async () => {
  const pol = policy();
  const c = await mintCookie(key, 'draft', 'pw', pol, NOW);
  const [v, cred, exp, mac] = c.split('.');
  assert.equal(await verifyCookie(key, 'other', c, pol, NOW), null, 'other slug');
  assert.equal(await verifyCookie(otherKey, 'draft', c, pol, NOW), null, 'other key');
  assert.equal(await verifyCookie(key, 'draft', `${v}.${cred}.${Number(exp) + 999}.${mac}`, pol, NOW), null, 'stretched expiry');
  assert.equal(await verifyCookie(key, 'draft', `${v}.${cred}.${exp}.${mac.slice(0, -2)}AA`, pol, NOW), null, 'bad mac');
  assert.equal(await verifyCookie(key, 'draft', c, pol, NOW + 8 * 86400), null, 'past 7 days');
  assert.equal(await verifyCookie(key, 'draft', c, policy({ password: PW_HASH.replace('a2V5', 'b2V5') }), NOW), null, 'password changed');
  assert.equal(await verifyCookie(key, 'draft', c, policy({ password: undefined }), NOW), null, 'password removed');
  assert.equal(await verifyCookie(key, 'draft', 'garbage', pol, NOW), null, 'garbage');
});

test('revoking one link drops only that link\'s cookies', async () => {
  const pol = policy({ links: [LINK, { id: 'zz9yy8', hash: 'B'.repeat(43) }] });
  const a = await mintCookie(key, 'draft', 'k7qm2x', pol, NOW);
  const b = await mintCookie(key, 'draft', 'zz9yy8', pol, NOW);
  const revoked = policy({ links: [{ id: 'zz9yy8', hash: 'B'.repeat(43) }] });
  assert.equal(await verifyCookie(key, 'draft', a, revoked, NOW), null);
  assert.equal(await verifyCookie(key, 'draft', b, revoked, NOW), 'zz9yy8');
});

test('a link cookie never outlives the link', async () => {
  const pol = policy({ links: [{ ...LINK, exp: new Date((NOW + 3600) * 1000).toISOString() }] });
  const c = await mintCookie(key, 'draft', 'k7qm2x', pol, NOW);
  assert.equal(await verifyCookie(key, 'draft', c, pol, NOW + 3000), 'k7qm2x');
  assert.equal(await verifyCookie(key, 'draft', c, pol, NOW + 3601), null);
  assert.equal(await mintCookie(key, 'draft', 'k7qm2x', pol, NOW + 3601), null, 'expired link mints nothing');
});

test('decide allows a valid cookie and asks browsers to log in otherwise', async () => {
  const pol = policy();
  const c = await mintCookie(key, 'draft', 'pw', pol, NOW);
  const base = { policy: pol, slug: 'draft', key, now: NOW, method: 'GET', accept: 'text/html,*/*' };
  assert.deepEqual(await decide({ ...base, cookieHeader: `x=1; ${cookieName('draft')}=${c}` }), { action: 'allow', cred: 'pw', via: 'cookie' });
  assert.deepEqual(await decide({ ...base, cookieHeader: '' }), { action: 'login' });
  assert.deepEqual(await decide({ ...base, method: 'HEAD', cookieHeader: '' }), { action: 'login' });
  assert.deepEqual(await decide({ ...base, method: 'POST', cookieHeader: '' }), { action: 'deny' });
  assert.deepEqual(await decide({ ...base, accept: 'application/json', cookieHeader: '' }), { action: 'deny' });
  assert.deepEqual(await decide({ ...base, cookieHeader: `${cookieName('other')}=${c}` }), { action: 'login' });
});

test('decide accepts a dkl_ bearer link token and ignores other bearers', async () => {
  const { token, hash } = await newLinkToken();
  const pol = policy({ links: [{ id: 'ab12cd', hash }] });
  const base = { policy: pol, slug: 'draft', key, now: NOW, method: 'POST', accept: '*/*', cookieHeader: '' };
  assert.deepEqual(await decide({ ...base, authorization: `Bearer ${token}` }), { action: 'allow', cred: 'ab12cd', via: 'bearer' });
  assert.deepEqual(await decide({ ...base, authorization: `bearer ${token}` }), { action: 'allow', cred: 'ab12cd', via: 'bearer' });
  assert.deepEqual(await decide({ ...base, authorization: `Bearer ${token}x` }), { action: 'deny' });
  assert.deepEqual(await decide({ ...base, authorization: 'Bearer app-own-token' }), { action: 'deny' });
  const expired = policy({ links: [{ id: 'ab12cd', hash, exp: new Date((NOW - 1) * 1000).toISOString() }] });
  assert.deepEqual(await decide({ ...base, policy: expired, authorization: `Bearer ${token}` }), { action: 'deny' });
});

test('safeReturn keeps the visitor inside the slug', () => {
  const cases = [
    ['/draft/', '/draft/'], ['/draft/a/b.html?x=1', '/draft/a/b.html?x=1'], ['/draft', '/draft'],
    ['//evil.example/', '/draft/'], ['https://evil.example/draft/', '/draft/'], ['/other/', '/draft/'],
    ['/drafty/', '/draft/'], ['/draft/../other/', '/draft/'], ['/draft/./x', '/draft/'],
    ['/draft\\x', '/draft/'], ['/draft/%0d%0aSet-Cookie', '/draft/'], ['/draft/\nx', '/draft/'],
    ['', '/draft/'], [undefined, '/draft/'], ['/draft//x', '/draft/'],
  ];
  for (const [input, want] of cases) assert.equal(safeReturn('draft', input), want, `input ${JSON.stringify(input)}`);
});

test('readCookie finds one cookie in a header', () => {
  assert.equal(readCookie('a=1; dk_access_draft=v1.pw.1.x; b=2', 'dk_access_draft'), 'v1.pw.1.x');
  assert.equal(readCookie('dk_access_drafts=nope', 'dk_access_draft'), null);
  assert.equal(readCookie(undefined, 'dk_access_draft'), null);
});

test('secureFor marks cookies Secure on public hosts and https, never on LAN or loopback', () => {
  assert.equal(secureFor('1', 'lan:8080', 'http'), true);
  assert.equal(secureFor('0', 'name.docklets.dev', 'https'), false);
  assert.equal(secureFor('auto', '192.168.1.5:8080', 'https'), true);
  assert.equal(secureFor('auto', 'name.docklets.dev', 'http'), true);
  for (const host of ['192.168.1.5:8080', 'localhost:18080', '127.0.0.1', '[::1]:8080', 'mybox:8080', 'mybox.local', '']) {
    assert.equal(secureFor('auto', host, 'http'), false, host);
  }
});

test('linkPath puts the token in the fragment, never the path or query', () => {
  assert.equal(linkPath('draft', 'dkl_abc'), '/draft/#dkl_abc');
});
