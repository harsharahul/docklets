/**
 * docklets access core: the decision behind private docklets, shared by every
 * front door that serves a name (the gateway's access service today, a router
 * or worker host later). Pure functions over WebCrypto, so the same module
 * runs under Node and Deno. Password checks (scrypt) are deliberately not
 * here: they run only at unlock time, inside the access service.
 *
 * Policy file <slug>/access.json, version 1:
 *   { "v": 1, "password": "scrypt$...", "links": [{ "id", "hash", "label"?, "exp"? }] }
 * The file's presence makes the slug private. Anything the parser does not
 * fully understand is an error, and callers fail closed on errors.
 *
 * Cookie value: v1.<cred>.<exp>.<mac>, where cred is "pw" or a link id. The
 * MAC binds the slug, the credential, the expiry, and that credential's stored
 * hash, so revoking a link or changing the password invalidates exactly the
 * cookies it issued, with no session store.
 */

const enc = new TextEncoder();

export const LINK_PREFIX = 'dkl_';
export const COOKIE_MAX_AGE = 7 * 24 * 3600;

const LINK_ID_RE = /^[a-z0-9]{6,16}$/;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const SCRYPT_RE = /^scrypt\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;
const BEARER_RE = /^Bearer\s+(dkl_[A-Za-z0-9_-]{43})$/i;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
// No i, l, o, 0, 1: generated passwords get read aloud and retyped.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function randomChars(alphabet, n) {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b < limit && out.length < n) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

const bad = (error) => ({ ok: false, error });

export function parsePolicy(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return bad('not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return bad('not a JSON object');
  if (doc.v !== 1) return bad('unsupported version');
  let password = null;
  if (doc.password !== undefined) {
    if (typeof doc.password !== 'string' || !SCRYPT_RE.test(doc.password)) return bad('password is not an scrypt hash');
    password = doc.password;
  }
  const links = [];
  if (doc.links !== undefined) {
    if (!Array.isArray(doc.links)) return bad('links is not a list');
    const ids = new Set();
    for (const l of doc.links) {
      if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !LINK_ID_RE.test(l.id) || ids.has(l.id)
        || typeof l.hash !== 'string' || !HASH_RE.test(l.hash)) return bad('bad link entry');
      let exp = null;
      if (l.exp !== undefined) {
        exp = Date.parse(l.exp) / 1000;
        if (!Number.isFinite(exp)) return bad('bad link expiry');
      }
      ids.add(l.id);
      links.push({ id: l.id, hash: l.hash, label: typeof l.label === 'string' ? l.label.slice(0, 80) : null, exp });
    }
  }
  return { ok: true, policy: { password, links } };
}

export async function sha256b64url(str) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str))));
}

/** A new secret link: the token goes to the owner once, only the hash is stored. */
export async function newLinkToken() {
  const token = LINK_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, hash: await sha256b64url(token) };
}

export function newLinkId() { return randomChars(ID_ALPHABET, 6); }

export function generatePassword() {
  const s = randomChars(PASSWORD_ALPHABET, 16);
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}

export function importAccessKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** The stored secret a credential is bound to, or null when it no longer opens anything. */
function credential(policy, cred, now) {
  if (cred === 'pw') return policy.password ? { secret: policy.password, exp: null } : null;
  const l = policy.links.find((x) => x.id === cred);
  if (!l || (l.exp !== null && l.exp <= now)) return null;
  return { secret: l.hash, exp: l.exp };
}

const macInput = (slug, cred, exp, secret) => enc.encode(`v1\n${slug}\n${cred}\n${exp}\n${secret}`);

export async function mintCookie(key, slug, cred, policy, now) {
  const c = credential(policy, cred, now);
  if (!c) return null;
  const exp = Math.floor(Math.min(now + COOKIE_MAX_AGE, c.exp ?? Infinity));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, macInput(slug, cred, exp, c.secret)));
  return `v1.${cred}.${exp}.${b64url(mac)}`;
}

/** The credential a cookie was issued for, or null when it no longer opens the slug. */
export async function verifyCookie(key, slug, value, policy, now) {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length !== 4) return null;
  const [v, cred, expText, mac] = parts;
  if (v !== 'v1' || !(cred === 'pw' || LINK_ID_RE.test(cred)) || !/^\d{1,12}$/.test(expText)) return null;
  const exp = Number(expText);
  if (exp <= now) return null;
  const c = credential(policy, cred, now);
  if (!c || (c.exp !== null && exp > c.exp)) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', key, fromB64url(mac), macInput(slug, cred, exp, c.secret));
    return ok ? cred : null;
  } catch { return null; }
}

export const cookieName = (slug) => `dk_access_${slug}`;

export function readCookie(header, name) {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * allow: serve it (via cookie or a dkl_ bearer link token, for API clients).
 * login: a browser page load; send it to the login page. deny: anything else.
 */
export async function decide({ policy, slug, key, now, method, accept, cookieHeader, authorization }) {
  const bearer = BEARER_RE.exec(authorization || '');
  if (bearer) {
    const h = await sha256b64url(bearer[1]);
    const l = policy.links.find((x) => x.hash === h && (x.exp === null || x.exp > now));
    if (l) return { action: 'allow', cred: l.id, via: 'bearer' };
  }
  const c = readCookie(cookieHeader, cookieName(slug));
  if (c) {
    const cred = await verifyCookie(key, slug, c, policy, now);
    if (cred) return { action: 'allow', cred, via: 'cookie' };
  }
  const page = (method === 'GET' || method === 'HEAD') && /text\/html/i.test(accept || '');
  return { action: page ? 'login' : 'deny' };
}

/** Where to send a visitor after unlocking: inside the slug, or the slug root. */
export function safeReturn(slug, raw) {
  const fallback = `/${slug}/`;
  if (typeof raw !== 'string' || raw.length > 2048) return fallback;
  if (!(raw === `/${slug}` || raw.startsWith(`/${slug}/`) || raw.startsWith(`/${slug}?`))) return fallback;
  if (/[\\\x00-\x1f\x7f]/.test(raw) || /%0[ad]/i.test(raw)) return fallback;
  const pathPart = raw.split(/[?#]/)[0];
  if (pathPart.includes('//') || /%2e/i.test(pathPart) || /\/\.\.?(\/|$)/.test(pathPart)) return fallback;
  return raw;
}

export const loginLocation = (slug, returnTo) =>
  `/.docklets/access/login?slug=${slug}&return=${encodeURIComponent(safeReturn(slug, returnTo))}`;

/**
 * Whether the access cookie gets the Secure flag. "1"/"0" force it; "auto"
 * sets it for https and for public hostnames, and leaves it off for loopback,
 * IP literals, single-label names, and the usual private LAN suffixes (served
 * over plain http, where browsers drop Secure cookies).
 */
const LAN_SUFFIXES = ['.local', '.localhost', '.lan', '.home', '.home.arpa', '.internal', '.localdomain'];

export function secureFor(mode, host, proto) {
  if (mode === '1') return true;
  if (mode === '0') return false;
  if (String(proto || '').toLowerCase() === 'https') return true;
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h || h === 'localhost' || h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) return false;
  if (!h.includes('.') || LAN_SUFFIXES.some((s) => h.endsWith(s))) return false;
  return true;
}

/** A secret link: the token rides in the fragment, which browsers never send to a server. */
export const linkPath = (slug, token) => `/${slug}/#${token}`;
