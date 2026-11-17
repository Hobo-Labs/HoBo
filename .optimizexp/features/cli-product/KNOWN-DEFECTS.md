# Known-defect characterizations (cli-product)

Scenarios tagged `@known-defect` assert the CURRENT, defective behavior of
the product CLIs so the suite stays green. The owning fix (separate work
stream) should flip the assertions and remove the tag. Do not "fix" these
scenarios to match desired behavior before the product fix lands.

## KD-1 — stub verb exit code (not reproducing; resolved upstream)

- Claim: stub verbs (26 un-wired verbs in `@hobo/cli`) exit 0 with a
  deceptive success-looking envelope.
- Observed (2026-07-31, this worktree): `hobo deploy --json` exits **1**
  with `ok:false, status:"not_implemented", code:"HOBO_CLI_STUB"`; text
  mode prints a `not_implemented` status table and also exits 1. Current
  behavior is non-deceptive, so the scenario asserts it **without** a
  `@known-defect` tag. Re-check if `shell/registry.ts` / `render.ts`
  change.

## KD-3 — boilerplate per-verb help missing flags (hobo) — FIXED in-flight

- Wired verbs previously rendered `hobo <verb> [global flags] [args]` with
  no verb-specific flags; only `new`, `stub`, `codegen` had real help.
- An uncommitted worktree fix (parallel agent, `packages/cli/src/shell/verbs.ts`)
  now gives every wired verb bespoke usage/flags/examples. Scenarios assert
  the FIXED behavior directly (`hobo build --help`, `hobo dev --help`) with
  no `@known-defect` tag — they fail if the fix is reverted.

## KD-4 — composed `hobo doctor` unreachable on this branch — FIXED

- The real `doctor` handler lives in `packages/hobo` (composed CLI), but
  `packages/hobo` failed to build: type drift in `src/broker-runtime.ts`
  (`ResolutionReceipt`/`ResolutionRejection` missing `stationId`/`railHash`,
  ADR-0131), a since-removed bridge module (`exactOptionalPropertyTypes`), and a
  runtime `UsageError: Cannot register unknown HoBo verb "messaging"`
  against `@hobo/cli`'s `CANONICAL_VERBS` (`messaging` and `serve` were
  registered in the composed CLI but never added to `CANONICAL_VERBS`).
- Fixed (this branch): `packages/hobo` builds, `messaging`/`serve` are
  canonical verbs, and the composed CLI serves the real doctor report.
  The `cli-help-and-doctor` scenarios now run
  `doctor --offline --json` against the composed bin
  (`packages/hobo/dist/bin/hobo.js`) via the shared step
  `I run the composed hobo CLI with arguments ...` — no `@known-defect`
  tag remains.

## Recorded but not scenario-pinned

- `--verbose` is accepted by the parser but ignored by `renderError`
  (`packages/cli/src/shell/render.ts`): error output is identical with and
  without it. Not pinned as a scenario because "identical output" is not a
  stable assertion target; flip `renderError` to honor it.
