# Folder sync

`bin/sync.mjs` mirrors a local folder to a machine running the sync receiver
(`bin/receiver.mjs`). The local folder is the source of truth: after a sync,
the remote folder contains exactly the files the local one does. Files that
are gone locally are deleted remotely. Use it to publish a folder to a hosted
deployment, or to mirror a docklets asset root between your own machines.

## What a sync carries, and what it never touches

A sync moves regular files with relative paths. It never touches, in either
direction:

- dot-entries at any depth (`.data`, `.gateway`, `.status.json`, `.git`,
  dotfiles): generated state and app data stay where they are. In
  particular, a dynamic app's `/data` state is not part of its code and
  does not travel with a sync.
- symlinks: skipped by the client, refused by the receiver.
- the top-level `status` folder: reserved for the dashboard, which the
  receiver seeds on first start.

A `404.html` at the folder root syncs like any other file, so a custom
not-found page works on the far side.

## Client

```sh
DOCKLETS_SYNC_URL=https://example.net \
DOCKLETS_SYNC_TOKEN=... \
node bin/sync.mjs ~/my-folder
```

| Setting | Meaning |
|---|---|
| `DOCKLETS_SYNC_URL` | base URL of the receiver (endpoints are appended) |
| `DOCKLETS_SYNC_TOKEN` | the sync token |
| `DOCKLETS_SYNC_TOKEN_FILE` | read the token from a file instead |
| `--dry-run` | report what would upload and what would be deleted, change nothing |
| `--yes` | required to sync an empty folder (which deletes everything remote) |

The client fingerprints every file with sha256 and uploads only what the
receiver does not already have; unchanged files cost nothing.

## Receiver

```sh
DOCKLETS_ROOT=/srv/folder \
DOCKLETS_SYNC_TOKEN_HASH_FILE=/etc/docklets/sync-hash \
node bin/receiver.mjs
```

| Env | Default | Meaning |
|---|---|---|
| `DOCKLETS_ROOT` | required | the folder syncs apply to |
| `DOCKLETS_SYNC_TOKEN_HASH_FILE` | required | file holding the scrypt hash of the token, one hash per line |
| `DOCKLETS_SYNC_TOKEN_HASH_FILES` | unset | colon-separated extra hash files; a missing one is skipped |
| `DOCKLETS_RECEIVER_PORT` | 9000 | listen port (0 picks a free one) |
| `DOCKLETS_RECEIVER_ADDR` | 127.0.0.1 | listen address |
| `DOCKLETS_SYNC_MAX_BYTES` | 2 GiB | total size cap for the mirrored folder |
| `DOCKLETS_SYNC_MAX_FILES` | 20000 | manifest entry cap |
| `DOCKLETS_SYNC_MAX_FILE_BYTES` | 100 MiB | per-file cap |
| `DOCKLETS_DASHBOARD` | bundled | dashboard dir seeded to `<root>/status` once |

Mint the token hash with:

```sh
node bin/receiver.mjs --hash "$(head -c 32 /dev/urandom | base64)"
```

Store the printed hash in the hash file; keep the plaintext for the client.
The receiver re-reads the hash files on every request, so rotating a token
is a file write, no restart. An unreadable primary hash file fails closed.

A hash file may hold several hashes, one per line, and
`DOCKLETS_SYNC_TOKEN_HASH_FILES` can name extra files. Any hash in any
readable file authorizes, so two writers (a laptop and a second machine, or
a managed control plane publishing on your behalf) each hold their own
token and can be rotated or revoked independently. Extra files are optional
by design: one that is missing is skipped, while the primary file must
always be readable.

## Protocol

Six endpoints, all JSON except file bodies. Every request except
`GET /healthz` carries `Authorization: Bearer <token>`.

1. `POST /sync/start` with `{"files":[{"path","size","sha256"}, ...]}`.
   Answers `{"session","need":[paths],"extraneous":[paths]}`: what to
   upload, and what the mirror will delete. One session at a time; a
   stale session (10 minutes) is discarded automatically.
2. `PUT /sync/file?session=S&path=P` with the raw file body. The receiver
   verifies size and sha256 while writing; a mismatch discards the upload
   (422). Files land in a hidden staging area, invisible to serving.
3. `POST /sync/finish` with `{"session"}`. Only now does the live folder
   change: staged files move into place, files absent from the manifest
   are deleted, empty directories are pruned. During this step the
   receiver holds `.sync-lock`, which the deployer's converge pass honors,
   so a half-applied sync is never deployed. Answers
   `{"ok",added,updated,deleted,bytes}`.
4. `POST /sync/abort` with `{"session"}` discards the staging area and
   changes nothing.
5. `GET /sync/manifest` answers `{"files":[{"path","size","sha256"}, ...]}`
   for the live tree, by the same rules as a client manifest (regular files
   only, sorted by path, dot-entries and the `status` folder excluded). A
   client that wants to change a few files fetches this, edits it, and
   runs a normal session with the result, so a partial update never
   deletes what it did not mean to.
6. `GET /sync/file?path=P` answers the raw bytes of one file as
   `application/octet-stream` with its `content-length`; 400 for a path
   the sync would never write (dot-entries, `status`, traversal), 404 when
   the path is not a regular file.

Errors are explicit: 401 wrong token, 400 invalid manifest entry or path,
404 no such file, 409 concurrent session or missing uploads, 413 over a
size cap, 422 content mismatch. Only one session exists at a time, and a
second `/sync/start` that overlaps the first answers 409 even while the
first is still hashing.
