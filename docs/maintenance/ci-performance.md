# CI performance notes

How the self-hosted HoBo CI keeps PR gates fast, and where to look when it slows down.

- **Parallel isolated containers.** The box worker (`packages/ci-gh-actions/scripts/isolated-worker-daemon.mts`)
  runs up to `HOBO_CI_WORKER_SLOTS` jobs at once, each capped by `HOBO_CI_WORKER_MEMORY_MB`. Raise the
  relay offer concurrency to match the slot count.
- **Shared pnpm store.** The box worker bind-mounts one content-addressed store into every job container
  and sets `HOBO_CI_PNPM_STORE_MOUNTED=1`; `.github/actions/pnpm-store` reads that from the process env
  (an `if: env.X` expression never sees container env) and skips `actions/cache`. A self-hosted runner
  without the mount installs from the registry: a cold `pnpm install` measured ~21s, while restoring the
  1.3 GB cache archive took 31–52s and main's save took 142s. Only GitHub-hosted runners use the cache.
- **Full clones.** Checkouts stay full (no `filter: blob:none`): a blobless clone fetches every blob
  lazily at checkout and timed out with HTTP 408 on this repo.
- **Slimmer impact gate.** `scripts/ci/affected-lanes.mts` filters the turbo lanes to the changed
  packages and examples. Root build inputs (lockfile, workspace, turbo, tsconfig, biome, toolchain pins,
  vendored sources) run the whole workspace; workflows, root scripts and draft proofs are covered by the
  root checks in the same gate. `scripts/test/affected-lanes.test.ts` pins the skip logic. Dependents are
  not added yet: several packages carry pre-existing biome lint debt that a dependents sweep would surface.
- **Trace export.** `.github/actions/ci-trace` runs `scripts/ci/ci-trace.mts` to export per-step timings
  from each job, so queue time and run time can be compared before and after a change.

## Frozen proofs and live-repo tests

`scripts/run-tests.ts` skips a frozen proof test that scans the live repo when its promoted package keeps
the maintained copy. The S0-04 codegen proof flagged ci-vercel's non-protobuf `src/_generated` files as
drift; `packages/schema-tools` already handles them, and the frozen proof cannot be edited.
