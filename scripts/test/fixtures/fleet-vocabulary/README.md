# Fleet guard scripts and their fixtures

The HoBo Fleet work (ADR-0182) is verified by a small set of root scripts. Each
is wired to a root `package.json` command and each has a test under
`scripts/test/`.

| Command | Script | What it checks |
|---|---|---|
| `pnpm run fleet:vocabulary` | `scripts/check-fleet-vocabulary.mts` | One implementation of each fleet idea (O1): nine rules, each over its own pathspecs, less `scripts/fleet-vocabulary-allow.json` |
| `pnpm run fleet:docs` | `scripts/check-fleet-docs.mts` | Vocabulary and documents agree (O27): events, ADR mentions, runbooks |
| `pnpm run fleet:contracts` | `scripts/check-fleet-contracts.mts` | The contracts did not drift (O26): the emitter's `--check`, then no snapshot or record changed since the newest `Fleet-Contract:` commit |
| `pnpm run fleet:outcome <id>` | `scripts/fleet-outcome.mts` | Runs one outcome of the design and prints its verification object |
| `pnpm run fleet:verify` | `scripts/fleet-verify.mts` | Runs every outcome through `fleet:outcome` and writes `fleet-verification.json` |

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
  are `RUNBOOK_FILES` in the script (named so that rule 9 does not find
  the guard scripts themselves): `install-and-upgrade.md`,
  `enroll-suspend-unlock-revoke.md`, `rotate-keys.md`,
  `backup-and-restore-drill.md`, `nats-server-loss.md`, `callout-outage.md`,
  `clone-alarm.md`, `claim-violation-alarm.md`, `witness-outage.md`,
  `relay-outage.md`, `one-active-fleet-stuck-sealed.md`.

## `fleet:contracts`

`node --import tsx scripts/check-fleet-contracts.mts [--root=<dir>] [--no-build]`
first builds the contract packages with turbo (the emitter reads workspace
dependencies through their built declarations), then runs
`scripts/emit-fleet-contracts.mts --check`, then
`git diff --exit-code <newest Fleet-Contract commit> -- 'packages/*/contracts/api.snapshot.d.ts' packages/fleet/data-models`.
Both must pass. Its tests are in `scripts/test/fleet-outcome.test.ts`.

## `fleet:outcome <id>`

`node --import tsx scripts/fleet-outcome.mts <id> [--root=<dir>]` holds the
outcome table (Check commands, Threshold, fallback threshold and the
assumptions it names) as data. It fails an outcome whose named file is missing
without running anything, runs the commands in order through `bash -c` (each
`vitest run` with `--reporter=json --outputFile=<tmp>`), stops at the first
nonzero exit, fails on any skipped or todo test, then evaluates the threshold
(for O20, the figures of `fleet-soak.json`). It prints
`{ id, pass, command, evidence, measured, fallbacks }` on stdout and exits 0
only when the outcome passes (2 on an unknown id).

When `fleet-fallbacks.json` lists an assumption the outcome names, the outcome
is judged against its fallback threshold: a skipped test whose title starts
with that id in brackets (`[A13] …`) is allowed. O21 (cutover) and O23 (the
deferred lane) are never passed by this command. Turbo-run checks
(`turbo run test`) are judged by exit code only: their skipped tests are not
counted.

## `fleet:verify`

`node --import tsx scripts/fleet-verify.mts [--root=<dir>] [--ids=O1,O2] [--include-deferred] [--out=<file>]`
runs each outcome in its own `fleet-outcome.mts` process and writes the
objects, in table order, to `fleet-verification.json` at the root (or
`--out`). O21 and O23 are left out unless `--include-deferred` is given. It
exits 1 when any outcome it ran did not pass; an outcome that printed no object
is recorded as failed.

## Fixtures

Each `rule-<n>/` directory here is a miniature repository that breaks rule `n`
and also holds an allowlisted, excluded or look-alike copy of the same thing
that must be accepted. `clean/` breaks nothing. The test points the guard at
each tree with `--root` and checks that it refuses exactly the expected files.
The source files carry `// @ts-nocheck` because they import packages the root
`tsconfig.json` cannot resolve; nothing compiles or runs them.
