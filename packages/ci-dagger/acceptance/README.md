# Native Dagger live acceptance

This manual lane runs the compiled `check-cli.js`, the real Dagger 1.x CLI, a real
operator-owned engine, and container commands. No Dagger Cloud account is used.
It is separate from the default offline unit/consumer-contract suite, following
the repository's manual live-service testing policy.

Prerequisites: Node 22+, installed workspace dependencies, Git, Dagger
1.0.0-beta.21, and a Linux container runtime or an existing compatible engine.
The Dang runtime is built into this engine; the fixture needs no downloaded
language SDK. Its Alpine toolchain is digest-pinned. The harness copies the
fixture into an owned temporary Git repository and deletes that repository after
the run. It does not modify the consuming repository or the user's Cloud login.

```sh
pnpm --filter @hobo/ci-dagger test:acceptance --dagger /path/to/dagger

# Reuse an engine that you operate:
pnpm --filter @hobo/ci-dagger test:acceptance \
  --dagger /path/to/dagger --engine container://my-dagger-engine

# Write human-readable evidence:
pnpm --filter @hobo/ci-dagger test:acceptance \
  --dagger /path/to/dagger --output /path/to/acceptance.md
```

`--version` changes the exact CLI version pin; the fixture declares a minimum
engine version of v1.0.0-beta.21. `--engine` accepts the same non-Cloud transports
as production configuration. The pretest shim builds the package with Turbo.

The scenarios verify:

- Compiled CLI planning and real passing/failing container checks.
- Check exclusions and failure for unmatched filters or an empty workspace.
- Named CI overlays and ordinary workspace defaults.
- Uncommitted source changes, including restoration to a passing state.
- Deadline exit 124, SIGINT exit 130 and SIGTERM exit 143.
- Invalid inherited Cloud/session credentials and an invalid saved Cloud login
  cannot redirect or authenticate the child; the original login remains intact.

The harness fails if any expected result differs. Cold image downloads may take
longer than warm runs; ordinary checks have a 90-second deadline. The deadline
scenario deliberately uses two seconds against a 60-second command.

In a corporate/managed HTTPS proxy environment, configure **the engine's** proxy
and CA trust too. Preserving the CLI's CA settings does not install the CA in an
engine container. Mount a trusted CA bundle read-only and set the engine's
`SSL_CERT_FILE`, or follow your engine operator's trust configuration. Keep TLS
verification enabled. A prepared engine can be selected with `container://NAME`.
The acceptance harness does not edit Docker registry credentials, daemon settings,
trust stores, or engine networking.

## Portable SDK live acceptance

The existing SDK adapter can also be verified against the real native engine.
Build the package, select a non-Cloud engine explicitly, and run the script in its
API session from the package directory:

```sh
dagger api with-session --engine=container://my-dagger-engine -- \
  node --import tsx acceptance/sdk.ts
```

The script requires an existing API session instead of provisioning another
engine. It uses a digest-pinned Debian image with GNU coreutils; `--image` selects
another reviewed digest-pinned toolchain. It verifies chained source snapshots,
clean step environments, binary artifact bytes and SHA-256, nonzero command exits
and logs, skipped later steps, and artifact symlinks escaping the workspace.
