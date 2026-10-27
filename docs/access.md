# Private docklets

A docklet is public unless its folder holds an `access.json`. With one, the
slug is private: visitors get in with a secret link or a password, and API
clients with a bearer token. It works the same for static sites and for
apps, on a self-hosted gateway, behind a tunnel, and on a hosted name.

## Making a slug private

Use the access command. It writes `<slug>/access.json`, stores only hashes,
and prints each secret exactly once:

```bash
cd <asset-root>
node <repo>/bin/access.mjs link drafts                          # a secret link
node <repo>/bin/access.mjs link drafts --label "for Acme" --expires 7d
node <repo>/bin/access.mjs password drafts                      # prompts; or pipe it on stdin
node <repo>/bin/access.mjs password drafts --generate           # prints a generated one
node <repo>/bin/access.mjs list                                 # every private slug
node <repo>/bin/access.mjs revoke drafts k7qm2x                 # by link id
node <repo>/bin/access.mjs password drafts --clear              # links only
node <repo>/bin/access.mjs public drafts                        # public again
```

The command reads `DOCKLETS_ROOT` (default: the current directory). Set
`DOCKLETS_PUBLIC_URL` (for example `https://alice-blog.docklets.dev`) to get
complete links; otherwise it prints the path to append to your gateway
address. A slug becomes private the moment the file exists; there is no
restart.

## How visitors get in

**Secret link.** A link looks like
`https://<host>/drafts/#dkl_<token>`. The token sits after the `#`, which
browsers never send to a server, so it stays out of access logs, proxies,
and `Referer` headers. Opening the link lands on the login page, which
trades the token for a cookie and removes it from the address bar. Anyone
holding the link can open the docklet until the link expires or is revoked.

**Password.** The login page shows a password field when the slug has a
password. Generated passwords use four groups from an alphabet without
look-alike characters (`k7qm-2xpd-9fta-wr3c`). Chosen passwords need 8 to
128 characters.

**Cookie.** Either way in sets one cookie, scoped to the slug's path,
`HttpOnly`, `SameSite=Lax`, valid for 7 days or until the link expires.
The cookie is bound to the credential that issued it: revoking a link logs
out that link's visitors, and changing the password logs out password
visitors. There is no session store. The `Secure` flag is set for https
and for public hostnames, and left off for loopback, IP literals, and LAN
names served over plain http.

**API clients.** A link token also works as a bearer token:
`Authorization: Bearer dkl_<token>`. The gateway strips that header before
the request reaches an app, so an app's own bearer tokens (any value that
does not start with `dkl_`) pass through untouched. Browser requests from
another origin to a private API fail at the CORS preflight; serve those
APIs from a public slug.

## The policy file

```json
{
  "v": 1,
  "password": "scrypt$16384$<salt>$<key>",
  "links": [{ "id": "k7qm2x", "hash": "<sha256, base64url>", "label": "for Acme", "exp": "2026-11-30T00:00:00Z" }]
}
```

- `password` and `links` are both optional. A file with neither keeps the
  slug private with no way in.
- Passwords are scrypt hashes; link tokens are stored as sha256 digests.
- The file is never served, even to a visitor who is signed in.
- A file the parser does not fully understand (a wrong version, a plaintext
  password, a malformed link) keeps the slug closed and logs the reason. So
  does a symlinked `access.json`.

Write it with the access command rather than by hand.

## How it works

The gateway asks the access service, `bin/access.mjs`, about every request
under a top-level name (Caddy `forward_auth`). The service reads the
policy file itself, so what the gateway can or cannot read never changes
the answer:

| Request | Answer |
|---|---|
| no `access.json` under that name | served (public) |
| valid cookie or `dkl_` bearer token | served, marked private |
| a page load (`GET`/`HEAD` accepting HTML) | `303` to `/.docklets/access/login` |
| anything else | `401` |
| unreadable or invalid `access.json` | `503`, the slug stays closed |

Before asking, the gateway refuses ambiguous paths (dot segments, double
slashes, and their encoded forms) with `400`, and any top-level name that
is not lowercase ASCII (`a-z`, `0-9`, `.`, `_`, `-`) with `404`. Slugs are
lowercase, and the app routes match paths case-insensitively, so a request
for `/NOTES/` must never reach the app `notes` past a check made for
`NOTES`. The gateway takes the name from the cleaned path, the same view
the file server and app routes use.

Responses from private slugs carry `Cache-Control: private`, overriding any
value an app sets, so shared caches and CDNs never store them; the access
service's own answers (redirects, the login page, refusals) are
`no-store`.

**Everything fails closed.** If the access service is down, the gateway
answers `502` for every request, public slugs included, rather than guess
which slugs are private.

Where it runs:

- **Self-hosted and tunneled:** `bin/serve.sh` starts it beside the
  gateway as the `docklets-access` container: read-only root filesystem,
  the asset root and key mounted read-only, all capabilities dropped,
  running as your user. It sits on an internal network
  (`<network>-access`) that only the gateway joins, so app containers
  cannot reach it.
- **Container image:** `bin/container-run.sh` starts it on
  `127.0.0.1:9100`, the gateway's default upstream; in a pod the gateway
  shares that localhost.

The cookie signing key is 32 random bytes at `<root>/.gateway/access-key`,
created once with mode 0600. Like every dot-entry, it is never served and
never synced.

## Sync keeps private docklets private

A sync never makes a docklet public by leaving its `access.json` out. If a
slug's `access.json` exists only on the receiver (set from a dashboard or a
chat, say) and the local folder still has other files in that slug, the
receiver keeps it and the client reports:

```
kept drafts private: its access.json exists only on the server. Make it public from the dashboard, from chat, or with --public drafts
```

Pass `--public <slug>` to remove it. Removing the whole slug removes its
`access.json` with it. A local `access.json` syncs like any other file.

## Configuration

| Variable | Default | |
|---|---|---|
| `DOCKLETS_ACCESS_ADDR` | `127.0.0.1` | listen address |
| `DOCKLETS_ACCESS_PORT` | `9100` | listen port |
| `DOCKLETS_ACCESS_KEY_FILE` | `<root>/.gateway/access-key` | cookie signing key |
| `DOCKLETS_ACCESS_SECURE` | `auto` | `1` or `0` force the cookie's `Secure` flag |
| `DOCKLETS_ACCESS_CLIENT_HEADER` | first `X-Forwarded-For` entry | header that names the visitor for failure limits, for example `CF-Connecting-IP` behind a CDN |
| `DOCKLETS_ACCESS_MAX_FAILS` | `10` | failed attempts per visitor per 10 minutes |
| `DOCKLETS_ACCESS_MAX_VERIFIES` | `2` | password checks at once (each scrypt check uses about 16 MB) |
| `DOCKLETS_ACCESS_UPSTREAM` | `127.0.0.1:9100` | where the gateway finds the access service |
| `DOCKLETS_ACCESS` | `docklets-access` | the access container's name (`serve.sh`) |
| `DOCKLETS_ACCESS_NETWORK` | `<network>-access` | the internal network it shares with the gateway (`serve.sh`) |

`bin/serve.sh` passes the `DOCKLETS_ACCESS_SECURE`, `_CLIENT_HEADER`,
`_MAX_FAILS`, and `_MAX_VERIFIES` values from its own environment to the
access container. Only failed passwords count toward the failure limit; a
link token is too long to guess, and counting failed redeems would only let
someone sharing a visitor's address lock them out. Behind a proxy or CDN,
every visitor arrives from the proxy's address, so set
`DOCKLETS_ACCESS_CLIENT_HEADER` to the header your edge sets (and that
visitors cannot forge), or the limit applies to all visitors together.

## Limits

- **Slugs on one gateway share an origin.** Script in another slug on the
  same host can make requests to a private slug with a visitor's cookie.
  Private docklets keep outsiders out; they do not isolate one owner's
  slugs from each other.
- **A secret link is a bearer credential.** Share it like a password, give
  it an expiry, and revoke it when it is no longer needed.
- **A leaked `access.json` allows offline guessing** of a weak chosen
  password. Generated passwords and link tokens are long enough that this
  does not matter for them.
- **It is not a substitute for an app's own authorization.** It decides
  who reaches a slug, not what they may do there.
