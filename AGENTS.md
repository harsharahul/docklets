# Web publishing instructions for AI agents

> Operator: paste this file (or the parts you want) into your agent's system
> prompt / standing instructions, and mount the asset root read-write into the
> agent's sandbox. Replace `<ASSETS>` with the mounted path (e.g.
> `/workspace/extra/web-assets`) and `<HOST>` with how users reach the gateway
> (e.g. `http://192.0.2.10:8080` or `https://apps.example.com`).

## Web Publishing

You can publish websites and web apps. Anything you place under
`<ASSETS>/<slug>/` is served live at `<HOST>/<slug>/`. There is no deploy step
and no restart; files are live the moment they are written.

Rules:

1. **Slug**: lowercase kebab-case directory name (e.g. `trip-planner`). One
   directory = one site = one route.
2. **`index.html` is required** at the top of the slug directory (static sites).
3. **Relative links only.** The site is served under a path prefix
   (`/<slug>/`), so absolute paths like `/style.css` will break. Use
   `style.css`, `./img/logo.png`, etc. Never hardcode a host or port.
4. **Self-contained**: keep CSS/JS/images inside the slug directory. No CDN
   dependencies unless the user asks.
5. **Atomic updates**: for a non-trivial rewrite of an existing site, build
   into `<ASSETS>/.staging-<slug>/`, then replace the real directory in one
   move. For small edits, editing in place is fine.
6. **Tell the user the route** when done: "published at `<HOST>/<slug>/`".
7. To **unpublish**, remove the slug directory, and only when the user asks.

### Dynamic apps (server-side "docklets")

An asset can also be a **running server**: an API, a backend, or server plus
frontend together. Add an `app.json` manifest to the slug directory and the
platform automatically runs it as its own sandboxed container behind the same
`/<slug>/` route (picked up within about 10 seconds; code changes
auto-redeploy):

```json
{ "runtime": "node", "entry": "server.js", "port": 3000, "install": false }
```

- **Runtimes**: `node` (node:20-alpine) or `python` (python:3.12-alpine).
  Listen on `process.env.PORT` / `os.environ["PORT"]`.
- Your server receives paths **with the `/<slug>/` prefix stripped** (a
  request to `/<slug>/api/x` arrives as `/api/x`). Use relative URLs in any
  frontend it serves.
- **Persistent state goes in `/data`**, a directory that survives crashes,
  redeploys, and restarts. Anything else (including your code dir) is
  throwaway.
- Code is mounted **read-only**; the container has no host access and no
  published ports (only reachable through the route), with memory/pid caps.
- Dependencies: prefer **zero-dependency** code. If you must use packages, add
  `package.json` / `requirements.txt` and set `"install": true` (installs at
  container start, so startups get slower).
- Crashes auto-restart. To **update**, just rewrite the files; the platform
  redeploys on change. To **stop the app**, delete `app.json` (the slug then
  serves as static files again); to unpublish entirely, remove the directory,
  and only when the user asks.
- If the app does not come up, tell the user to check the deployer log
  (`<root>/.gateway/logs/deployer.log`) and `docker logs docklet-<slug>`; you
  cannot see those yourself.
