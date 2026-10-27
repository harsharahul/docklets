#!/usr/bin/env node
/**
 * docklets sync: mirror a local folder to a docklets sync receiver.
 *
 * The local folder is the source of truth. The client fingerprints every
 * file (sha256), sends the manifest, uploads only what the server does not
 * already have, and the server then mirrors the folder exactly: files that
 * are gone locally are deleted remotely. App state (.data) and generated
 * files (dot-entries) are never part of a sync in either direction.
 *
 * One exception keeps private docklets private: a slug's access.json that
 * exists only on the server (set from a dashboard or from chat) is kept,
 * and the slug stays private, unless --public <slug> says otherwise.
 *
 * Usage: node sync.mjs [--dry-run] [--yes] [--public <slug>]... <folder>
 * Env:   DOCKLETS_SYNC_URL          base URL of the sync endpoint
 *        DOCKLETS_SYNC_TOKEN        the sync token (or ..._FILE with a path)
 */
import fs from 'node:fs';
import path from 'node:path';
import { walkManifest } from './sync-common.mjs';

function die(msg) { console.error(`sync: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
let dryRun = false, yes = false, folder;
const makePublic = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--yes') yes = true;
  else if (a === '--public') {
    const s = args[++i];
    if (!s || s.startsWith('--')) die('--public needs a slug');
    makePublic.push(s);
  } else if (!a.startsWith('--') && folder === undefined) folder = a;
  else die(`unexpected argument: ${a}`);
}
const URL_BASE = (process.env.DOCKLETS_SYNC_URL || '').replace(/\/+$/, '');

if (!folder) die('usage: sync.mjs [--dry-run] [--yes] [--public <slug>]... <folder>');
const root = path.resolve(folder);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) die(`not a directory: ${root}`);
if (!URL_BASE) die('DOCKLETS_SYNC_URL is not set');
let token = process.env.DOCKLETS_SYNC_TOKEN || '';
if (!token && process.env.DOCKLETS_SYNC_TOKEN_FILE) {
  try { token = fs.readFileSync(process.env.DOCKLETS_SYNC_TOKEN_FILE, 'utf8').trim(); }
  catch { die('cannot read DOCKLETS_SYNC_TOKEN_FILE'); }
}
if (!token) die('DOCKLETS_SYNC_TOKEN is not set');

async function api(method, p, body, raw) {
  let res;
  try {
    res = await fetch(URL_BASE + p, {
      method,
      headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch (e) { die(`cannot reach ${URL_BASE}: ${e.cause?.code || e.message}`); }
  if (res.status === 401) die('unauthorized: the sync token was refused');
  if (res.status === 503) die('the receiver is not ready (token hash unreadable)');
  return res;
}

const manifest = await walkManifest(root);
if (manifest.length === 0 && !yes) {
  die(`${root} contains no syncable files; a sync would delete everything remote. Pass --yes to mirror an empty folder.`);
}

const start = await api('POST', '/sync/start', { files: manifest, ...(makePublic.length ? { public: makePublic } : {}) });
const startBody = await start.json();
if (start.status !== 200) die(`start refused (${start.status}): ${startBody.error}`);
const { session, need, extraneous } = startBody;
const keptSlugs = (startBody.kept || []).map((p) => p.split('/')[0]);

if (dryRun) {
  console.log(`would upload ${need.length} file(s), would delete ${extraneous.length} file(s), ${manifest.length} total in the mirror`);
  if (keptSlugs.length) console.log(`would keep ${keptSlugs.length} docklet${keptSlugs.length > 1 ? 's' : ''} private: ${keptSlugs.join(', ')}`);
  await api('POST', '/sync/abort', { session });
  process.exit(0);
}

for (const p of need) {
  const buf = fs.readFileSync(path.join(root, p));
  const r = await api('PUT', `/sync/file?session=${session}&path=${encodeURIComponent(p)}`, null, buf);
  if (r.status !== 200) {
    const b = await r.json().catch(() => ({}));
    await api('POST', '/sync/abort', { session });
    die(`upload of ${p} refused (${r.status}): ${b.error || ''}`);
  }
}

const fin = await api('POST', '/sync/finish', { session });
const sum = await fin.json();
if (fin.status !== 200) die(`finish refused (${fin.status}): ${sum.error}`);
console.log(`synced: added ${sum.added}, updated ${sum.updated}, deleted ${sum.deleted} (${sum.bytes} bytes uploaded)`);
for (const s of keptSlugs) {
  console.log(`kept ${s} private: its access.json exists only on the server. Make it public from the dashboard, from chat, or with --public ${s}`);
}
