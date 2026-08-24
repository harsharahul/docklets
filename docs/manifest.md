# Manifest reference

`app.json` at the top of a slug directory turns that slug from a static site
into a docklet (a running server). The file is read by the deployer on every
converge pass.

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `runtime` | string | yes | `"node"` (node:20-alpine) or `"python"` (python:3.12-alpine) |
| `entry` | string | yes | Path of the program to run, relative to the slug directory. Must not be absolute or contain `..` |
| `port` | integer | yes | Port the app listens on, 1-65535. Also passed to the app as `$PORT` |
| `env` | object | no | Extra environment variables. Keys must match `[A-Za-z_][A-Za-z0-9_]*`. For non-secret values only |
| `install` | boolean | no | `true` runs the runtime's dependency install at container start: `npm install --omit=dev` when `package.json` exists, `pip install -r requirements.txt` when `requirements.txt` exists. Default `false` |

Unknown fields are ignored. An invalid manifest is skipped with a logged
reason, and the slug keeps serving whatever it served before.

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
| `app.json` appears | container created, route added, gateway reloaded |
| any file in the slug changes | container recreated with the new code |
| `port` changes | container recreated, route rewritten |
| app crashes | Docker restarts it (`unless-stopped`), independent of the deployer |
| `app.json` deleted | container and route removed; slug serves as static files again |
| slug directory deleted | container and route removed |

`/data` contents are never touched by any lifecycle event; state placed there
persists until the operator deletes `<root>/.data/<slug>/` manually.

## Contract inside the container

- The app must listen on `$PORT` on all interfaces (`0.0.0.0`).
- Request paths arrive with the `/<slug>/` prefix stripped.
- The working directory is `/app`, a writable copy of the read-only `/src`.
- `/data` is the only writable location that outlives the container.
- There is no docker socket, no host filesystem, and no published port; the
  only way in is through the gateway route.
