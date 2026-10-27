/**
 * Shared helpers for the docklets sync protocol: what a synced folder
 * contains (regular files only, never dot-entries, never symlinks, never a
 * reserved top-level name), how files are fingerprinted (sha256), and how
 * the sync token is stored (scrypt hash; the plaintext exists only client
 * side and in flight).
 */
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;
const MAX_PATH = 1024;

// Top-level names a synced folder never contains: the seeded status
// dashboard, and the filesystem's lost+found (a volume mounted as the root
// has one, and fsck recreates it root-only when the volume is re-attached).
export const RESERVED_TOP = new Set(['status', 'lost+found']);

export function validRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return false;
  if (p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  for (const part of parts) {
    if (!part || part === '..' || part.startsWith('.')) return false;
  }
  if (RESERVED_TOP.has(parts[0])) return false;
  return true;
}

export function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export async function walkManifest(root) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && RESERVED_TOP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(p, r); continue; }
      if (!e.isFile()) continue;
      out.push({ path: r, size: fs.statSync(p).size, sha256: await hashFile(p) });
    }
  };
  await walk(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function scryptHash(token) {
  const salt = randomBytes(16);
  const key = scryptSync(token, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parseScrypt(stored) {
  const [tag, n, salt, key] = String(stored).trim().split('$');
  if (tag !== 'scrypt') return null;
  // Two wire encodings exist for salt and key: this repo mints base64url
  // (22-char salt), managed control planes store hex (32-char salt).
  // Salt shape discriminates unambiguously.
  const enc = /^[0-9a-f]{32}$/.test(salt) ? 'hex' : 'base64url';
  const want = Buffer.from(key, enc);
  if (want.length !== KEY_LEN) return null;
  return { want, salt: Buffer.from(salt, enc),
    opts: { N: Number(n), r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 } };
}

export function scryptVerify(token, stored) {
  try {
    const s = parseScrypt(stored);
    return !!s && timingSafeEqual(s.want, scryptSync(token, s.salt, KEY_LEN, s.opts));
  } catch { return false; }
}

/** scryptVerify off the event loop (libuv pool), for servers that must keep answering. */
export function scryptVerifyAsync(token, stored) {
  return new Promise((resolve) => {
    let s;
    try { s = parseScrypt(stored); } catch { s = null; }
    if (!s) return resolve(false);
    try {
      scrypt(token, s.salt, KEY_LEN, s.opts, (err, got) => resolve(!err && timingSafeEqual(s.want, got)));
    } catch { resolve(false); }
  });
}
