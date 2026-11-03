# Manifest reference

`app.json` at the top of a slug directory turns that slug from a static site
into a docklet (a running server). The file is read by the deployer on every
converge pass.

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `runtime` | string | yes | `"node"` (node:20-alpine), `"python"` (python:3.12-alpine), or `"worker"` (see [Workers](#workers)) |
| `entry` | string | yes | Path of the program to run, relative to the slug directory. Must not be absolute or contain `..` |
| `port` | integer | yes for `node` and `python` | Port the app listens on, 1-65535. Also passed to the app as `$PORT`. Not used by `worker` |
| `env` | object | no | Extra environment variables. Keys must match `[A-Za-z_][A-Za-z0-9_]*`. For non-secret values only |
| `install` | boolean | no | `true` runs the runtime's dependency install at container start: `npm install --omit=dev` when `package.json` exists, `pip install -r requirements.txt` when `requirements.txt` exists. Default `false` |

Unknown fields are ignored. An invalid manifest is skipped with a logged
reason, and the slug keeps serving whatever it served before.

`access.json` beside `app.json` is also reserved: it makes the slug private
(see [access.md](access.md)). Neither file is ever served, and changing
`access.json` never restarts the app.

## Examples

Minimal node app:

```json
{ "runtime": "node", "entry": "server.js", "port": 3000 }
```

Python app with dependencies and configuration:

```json
{
  "runtime": "python",
  "entry": "app.py",
  "port": 8000,
  "env": { "LOG_LEVEL": "info" },
  "install": true
}
```

## Lifecycle

| Event | Effect |
|---|---|
| `app.json` appears | container created, route added, gateway reloaded (`worker`: the slug is marked and routed to the worker host; no container) |
| any file in the slug changes | container recreated with the new code |
| `port` changes | container recreated, route rewritten |
| app crashes | Docker restarts it (`unless-stopped`), independent of the deployer |
| `app.json` deleted | container and route removed; slug serves as static files again |
| slug directory deleted | container and route removed |

`/data` contents are never touched by any lifecycle event; state placed there
persists until the operator deletes `<root>/.data/<slug>/` manually.

## Workers

`"runtime": "worker"` runs the slug as a request handler in a shared,
sandboxed JavaScript runtime instead of a container: no port, no process,
nothing idling while nobody visits. Today the worker runtime runs on hosted
docklets (docklets.dev); a self-hosted deployer recognizes the manifest,
marks the slug, and reports it `pending` until a local worker runtime
exists.

```json
{ "runtime": "worker", "entry": "worker.js", "env": { "GREETING": "hi" } }
```

`entry` is an ES module that exports a fetch handler:

```js
export default {
  async fetch(request, env) {
    return Response.json({ path: new URL(request.url).pathname, greeting: env.GREETING });
  },
};
```

- Requests arrive with the `/<slug>/` prefix stripped, like process apps;
  the prefix rides in the `X-Docklets-Prefix` header. `/<slug>` without a
  slash redirects to `/<slug>/`.
- `env` carries the manifest's `env` values, and `env.DB`, the docklet's
  own database (below).
- `install` and `port` are ignored. There is no `/data` and no writable
  filesystem; keep state in `env.DB`.
- Dependencies are bundled into the folder as ES modules (relative imports
  only). There is no `npm` and no remote import at run time, and no
  outbound network from the handler.
- Data ships as modules, not files: the handler cannot read files from the
  folder at run time, so import JSON and text as modules instead.
- `access.json` works exactly as for a static slug: a private worker opens
  with its link, password, or cookie, and the handler never sees the
  credential.
- Streaming responses and WebSocket upgrades are supported.

Limits per docklet (hosted defaults):

| Limit | Value |
|---|---|
| Memory | 64 MiB |
| CPU per request | 50 ms (soft), 200 ms (hard) |
| Wall clock per request | 30 s |
| Request body | 1 MiB |
| Folder as a bundle | 1 MiB, 50 files |

### env.DB: the docklet's database

Every worker docklet on a hosted name can keep data in its own SQLite
database, shared by the name's worker docklets and by nothing else. It is
created on first use and removed with the name.

```js
await env.DB.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
const { lastId } = await env.DB.exec('INSERT INTO notes (text) VALUES (?)', ['hello']);
const rows = await env.DB.query('SELECT id, text FROM notes ORDER BY id');   // [{ id: 1, text: 'hello' }]

await env.DB.kv.put('greeting', 'hi');          // strings under keys
await env.DB.kv.get('greeting');                // 'hi' (null when absent)
await env.DB.kv.list('user:');                  // [{ key, value }], by prefix
await env.DB.kv.del('greeting');                // true when it existed
```

- `query(sql, params)` returns rows as objects; `exec(sql, params)` returns
  `{ changes, lastId }`. Parameters are `?` placeholders: numbers, strings,
  booleans, `null`, and `Uint8Array` for blobs.
- A statement that fails throws with SQLite's message. `ATTACH`,
  `VACUUM INTO`, extensions, and schema-editing pragmas are refused.
- Each call is its own statement; transactions across calls are not
  available yet.

| Limit | Value |
|---|---|
| Database size | 20 MB |
| One call | 5 s (a longer query is stopped) |
| Calls at once, per name | 4 |

`examples/guestbook-worker` keeps a guestbook in `env.DB`.

A request that crosses a limit answers `546`; a handler that fails to load
answers `547`, and the reason shows on the name's page at docklets.dev.

The gateway routes a worker slug by an empty `.worker` marker file that the
receiver and the deployer keep beside its `app.json` (a dot-entry: never
served, never synced). Nothing in the folder needs to change for it.

## Contract inside the container

- The app must listen on `$PORT` on all interfaces (`0.0.0.0`).
- Request paths arrive with the `/<slug>/` prefix stripped.
- The working directory is `/app`, a writable copy of the read-only `/src`.
- `/data` is the only writable location that outlives the container.
- There is no docker socket, no host filesystem, and no published port; the
  only way in is through the gateway route.
