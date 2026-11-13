# Fleet guard scripts and their fixtures

The HoBo Fleet work (ADR-0182) is verified by a small set of root scripts. Each
is wired to a root `package.json` command and each has a test under
`scripts/test/`.

| Command | Script | What it checks |
|---|---|---|
| `pnpm run fleet:vocabulary` | `scripts/check-fleet-vocabulary.mts` | One implementation of each fleet idea (O1): nine rules, each over its own pathspecs, less `scripts/fleet-vocabulary-allow.json` |
| `pnpm run fleet:docs` | `scripts/check-fleet-docs.mts` | Vocabulary and documents agree (O27): events, ADR mentions, runbooks |

## `fleet:vocabulary`

`node --import tsx scripts/check-fleet-vocabulary.mts [--root=<dir>] [--json]`
exits 1 when any rule finds something and prints one line per finding
(`rule <n>: <path>:<line>: <detail>`); `--json` also writes
`{ "findings": [...] }` to stdout.

| Rule | Finds | Pathspecs | Allowlist |
|---|---|---|---|
| 1 | An import of, or a dependency on, `@nats-io/*` | `packages/*/src/**`, `packages/*/test/**`, `packages/*/package.json`, `scripts/**` | `packages/fleet-nats/**` |
| 2 | An import of, or a dependency on, `@number0/iroh` | as rule 1 | `packages/fleet-p2p/**` |
| 3 | A function, `const`, class or object method named after a fleet-owned function (names only) | `packages/*/src/**`, `scripts/**` | `packages/fleet/src/**` |
| 4 | A protobuf `message` named after a fleet record | `packages/**/*.proto` | `packages/fleet/data-models/**` |
| 5 | An identifier containing `InternalMesh`, `INTERNAL_MESH` or `internalMesh` | `packages/*/src/**`, `packages/*/test/**`, `scripts/**` | none |
| 6 | A removed environment variable (`HOBO_CI_MESH_*`, `HOBO_CI_NATS_*`, `HOBO_CI_FLEET_STATE`, `HOBO_CI_FLEET_CAPACITY*`, `HOBO_CI_FLEET_ROUTES`, `HOBO_CI_LOCAL_RUNNER`, `HOBO_CI_LOCAL_REPOSITORY`, `HOBO_CI_LOCAL_TRUSTED`, `HOBO_TAILSCALE_AUTHKEY`) | `packages/*/src/**`, `packages/*/test/**`, `packages/*/scripts/**`, `scripts/**`, `.github/**`, `.devcontainer/**`, `deploy/**` | none |
| 7 | A path the fleet work deletes that still exists | the paths themselves | none |
| 8 | The specifier `@hobo/backend-fleet` or `@hobo/ci/mesh` | as rule 1, and `.github/**` | none |
| 9 | An exported name starting with `Fleet`, `fleet` or `FLEET_` | `packages/*/src/**`, `scripts/**`, except `packages/fleet*/**` | see the allowlist file |

The guard, its allowlist, its test and everything in this directory are never
scanned, nor is anything under `docs/` or `site/`. An allowlist entry is
`{ rule, path, reason }`; adding one is a coordinator amendment.

## `fleet:docs`

`node --import tsx scripts/check-fleet-docs.mts [--root=<dir>]` exits 1 and
prints one line per gap when:

- an event type in `packages/fleet/src/events.ts` is missing from
  `docs/design/fleet.md`, or from the `fleet.*` row of
  `docs/design/event-families.md`;
- an `ADR-NNNN` named in `docs/design/fleet.md` or `docs/design/adr/fleet.md`
  is not a row of `docs/design/adr/index.md`;
- a runbook file is missing under `docs/maintenance/fleet/`. The eleven names
  are `FLEET_RUNBOOKS` in the script: `install-and-upgrade.md`,
  `enroll-suspend-unlock-revoke.md`, `rotate-keys.md`,
  `backup-and-restore-drill.md`, `nats-server-loss.md`, `callout-outage.md`,
  `clone-alarm.md`, `claim-violation-alarm.md`, `witness-outage.md`,
  `relay-outage.md`, `one-active-fleet-stuck-sealed.md`.

## Fixtures

Each `rule-<n>/` directory here is a miniature repository that breaks rule `n`
and also holds an allowlisted, excluded or look-alike copy of the same thing
that must be accepted. `clean/` breaks nothing. The test points the guard at
each tree with `--root` and checks that it refuses exactly the expected files.
The source files carry `// @ts-nocheck` because they import packages the root
`tsconfig.json` cannot resolve; nothing compiles or runs them.
