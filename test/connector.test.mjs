import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONNECTOR = new URL('../bin/connector.sh', import.meta.url).pathname;
const FRP_VERSION = fs.readFileSync(CONNECTOR, 'utf8').match(/^FRP_VERSION="([^"]+)"/m)[1];

// A connector home with the tunnel client already "fetched": a stand-in
// binary that prints the generated config instead of dialing anything.
function makeHome(envLines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-connector-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, 'bin', `frpc-${FRP_VERSION}`),
    '#!/bin/sh\n[ "$1" = "-c" ] || exit 9\ncat "$2"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'connector.env'), envLines.join('\n') + '\n', { mode: 0o600 });
  return home;
}

function run(home) {
  return spawnSync('bash', [CONNECTOR], {
    encoding: 'utf8',
    env: { ...process.env, DOCKLETS_CONNECTOR_HOME: home, DOCKLETS_CONNECTOR_CONFIG: path.join(home, 'connector.env') },
  });
}

test('the generated client config keeps the application heartbeat on', () => {
  // frp turns its own heartbeat off when tcpMux is on. The edge's Ping hook
  // is what keeps a name's "last seen" current, so the connector asks for it.
  const home = makeHome(['TUNNEL_SERVER=edge.example.com', 'TUNNEL_TOKEN=t0k', 'TUNNEL_NAME=alice-den']);
  const r = run(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^transport\.heartbeatInterval = 30$/m);
  assert.match(r.stdout, /^transport\.heartbeatTimeout = 90$/m);
  assert.match(r.stdout, /^subdomain = "alice-den"$/m);
});
