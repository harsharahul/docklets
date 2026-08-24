# Contributing

## Principles

These are the constraints that keep the project what it is. Contributions that
break them will be declined regardless of code quality.

1. **The filesystem is the control plane.** No feature may introduce a network
   deploy API, deploy credentials, or a privileged endpoint. Deploy authority
   is write access to the asset root, full stop.
2. **Security defaults are non-negotiable.** App containers keep
   `cap-drop ALL`, `no-new-privileges`, resource caps, read-only code mounts,
   and no published ports. Hardening may be added, never removed or made
   opt-in.
3. **The core stays small and readable.** The deployer is a single
   zero-dependency script an operator can audit in one sitting. No frameworks,
   no dependency tree.
4. **Docs describe shipped behavior**, in present tense. Planned work belongs
   in the README roadmap as neutral one-liners, not in the docs.

## Development

Requirements: Docker, Node 20 or newer, bash.

```bash
# syntax checks
node --check bin/deployer.mjs
bash -n bin/serve.sh install/*.sh

# full end-to-end smoke test on an isolated port
TESTROOT=$(mktemp -d)
cp -R examples/guestbook examples/hello-static "$TESTROOT"/
DOCKLETS_ROOT="$TESTROOT" DOCKLETS_PORT=8081 DOCKLETS_NETWORK=dk-test \
  DOCKLETS_GATEWAY=dk-test-gw ./bin/serve.sh &
DOCKLETS_ROOT="$TESTROOT" DOCKLETS_NETWORK=dk-test DOCKLETS_GATEWAY=dk-test-gw \
  DOCKLETS_PREFIX=dk-test- node bin/deployer.mjs --once
curl -sf http://localhost:8081/hello-static/ >/dev/null
curl -sf http://localhost:8081/guestbook/api/messages >/dev/null
docker rm -f dk-test-gw dk-test-guestbook; docker network rm dk-test
```

CI runs the same smoke test on every push and pull request; keep it green.

## Pull requests

- One change per PR, with the smoke test passing.
- Commit messages: `type: short description` (`feat:`, `fix:`, `docs:`,
  `ci:`, `refactor:`).
- Security-relevant changes must update SECURITY.md in the same PR.
