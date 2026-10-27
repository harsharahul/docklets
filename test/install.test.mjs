import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTALL = new URL('../install/', import.meta.url).pathname;

// The installers run against a temporary home, with launchctl, systemctl,
// and docker replaced by stand-ins that only record how they were called.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-install-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const calls = path.join(dir, 'calls');
  for (const cmd of ['launchctl', 'systemctl', 'docker']) {
    fs.writeFileSync(path.join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
  }
  const run = (script, env = {}) => spawnSync('bash', [path.join(INSTALL, script), path.join(dir, 'root'), '18090'], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, ...env },
  });
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return { dir, home, run, read, calls: () => read(calls) ?? '' };
}

test('macOS: auto-update off writes the settings and no updater job', () => {
  const s = sandbox();
  const r = s.run('install-macos.sh', { DOCKLETS_AUTO_UPDATE: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.read(path.join(s.home, '.config/docklets/install.env')), /^DOCKLETS_PORT=18090\nDOCKLETS_AUTO_UPDATE=0$/m);
  assert.equal(fs.existsSync(path.join(s.home, 'Library/LaunchAgents/com.docklets.updater.plist')), false);
  assert.match(s.calls(), /launchctl bootstrap .*com\.docklets\.gateway\.plist/);
});

test('macOS: auto-update on adds a nightly updater job and remembers the choice', () => {
  const s = sandbox();
  assert.equal(s.run('install-macos.sh', { DOCKLETS_AUTO_UPDATE: '1' }).status, 0);
  const plist = s.read(path.join(s.home, 'Library/LaunchAgents/com.docklets.updater.plist'));
  assert.match(plist, /install\/update\.sh<\/string><string>--auto</);
  const hour = Number(plist.match(/<key>Hour<\/key><integer>(\d+)</)[1]);
  assert.ok(hour === 3 || hour === 4, `hour ${hour}`);
  assert.doesNotMatch(plist, /KeepAlive|RunAtLoad/);
  assert.match(s.calls(), /launchctl bootstrap .*com\.docklets\.updater\.plist/);
  // A later re-run without the variable keeps the saved choice.
  assert.equal(s.run('install-macos.sh').status, 0);
  assert.match(s.read(path.join(s.home, '.config/docklets/install.env')), /DOCKLETS_AUTO_UPDATE=1/);
});

test('macOS: an update in progress never reloads the updater job running it', () => {
  const s = sandbox();
  assert.equal(s.run('install-macos.sh', { DOCKLETS_AUTO_UPDATE: '1', DOCKLETS_UPDATE_RUNNING: '1' }).status, 0);
  assert.doesNotMatch(s.calls(), /com\.docklets\.updater/);
  assert.match(s.calls(), /launchctl bootstrap .*com\.docklets\.gateway\.plist/);
});

test('Linux: services restart on every run, and the updater timer follows the choice', () => {
  const s = sandbox();
  assert.equal(s.run('install-linux.sh', { DOCKLETS_AUTO_UPDATE: '1' }).status, 0);
  const units = path.join(s.home, '.config/systemd/user');
  assert.match(s.read(path.join(units, 'docklets-updater.timer')), /RandomizedDelaySec=2h/);
  assert.match(s.read(path.join(units, 'docklets-updater.service')), /update\.sh --auto/);
  assert.match(s.calls(), /systemctl --user restart docklets-gateway docklets-deployer/);
  assert.match(s.calls(), /systemctl --user enable --now docklets-updater\.timer/);
  assert.equal(s.run('install-linux.sh', { DOCKLETS_AUTO_UPDATE: '0' }).status, 0);
  assert.equal(fs.existsSync(path.join(units, 'docklets-updater.timer')), false);
  assert.match(s.calls(), /systemctl --user disable --now docklets-updater\.timer/);
});
