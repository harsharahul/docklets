/**
 * Shared helpers for the docklets sync protocol: what a synced folder
 * contains (regular files only, never dot-entries, never symlinks, never the
 * reserved status dashboard), how files are fingerprinted (sha256), and how
 * the sync token is stored (scrypt hash; the plaintext exists only client
 * side and in flight).
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;
const MAX_PATH = 1024;

export function validRelPath(p) {
  if (typeof p !== 'string' || !p || p.length > MAX_PATH) return false;
  if (p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  for (const part of parts) {
    if (!part || part === '..' || part.startsWith('.')) return false;
  }
  if (parts[0] === 'status') return false; // reserved: the seeded dashboard
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
      if (!rel && e.name === 'status') continue;
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

export function scryptVerify(token, stored) {
  try {
    const [tag, n, salt, key] = String(stored).trim().split('$');
    if (tag !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64url');
    const got = scryptSync(token, Buffer.from(salt, 'base64url'), want.length,
      { N: Number(n), r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
    return want.length === KEY_LEN && timingSafeEqual(want, got);
  } catch { return false; }
}
