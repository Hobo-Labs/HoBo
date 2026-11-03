# CI performance notes

How the self-hosted HoBo CI keeps PR gates fast, and where to look when it slows down.

- **Parallel isolated containers.** The box worker (`packages/ci-gh-actions/scripts/isolated-worker-daemon.mts`)
  runs up to `HOBO_CI_WORKER_SLOTS` jobs at once, each capped by `HOBO_CI_WORKER_MEMORY_MB`. Raise the
  relay offer concurrency to match the slot count.
- **No shared database on the box.** The worker keeps its lease journal and webhook inbox in a local
  SQLite file (`@hobo/ci/sqlite`, `${XDG_DATA_HOME:-~/.local/share}/hobo-ci/worker.sqlite`) and polls
  GitHub every `HOBO_CI_JOB_POLL_MS` for queued `runs-on: hobo` jobs, so CI does not stop when a hosted
  Postgres quota or webhook relay does. `HOBO_CI_STORE=postgres` (or `"store": {"kind": "postgres",
  "urlEnv": …}` in the CI project config) keeps the shared-relay path. `ci-store-contract.test.ts` runs
  one suite against both stores; see `packages/ci/RUNNER-QUEUE.md` for the env vars.
- **Shared pnpm store.** The box worker bind-mounts one content-addressed store into every job container
  and sets `HOBO_CI_PNPM_STORE_MOUNTED=1`; `.github/actions/pnpm-store` reads that from the process env
  (an `if: env.X` expression never sees container env) and skips `actions/cache`. A self-hosted runner
  without the mount installs from the registry: a cold `pnpm install` measured ~21s, while restoring the
  1.3 GB cache archive took 31–52s and main's save took 142s. Only GitHub-hosted runners use the cache.
- **Full clones.** Checkouts stay full (no `filter: blob:none`): a blobless clone fetches every blob
  lazily at checkout and timed out with HTTP 408 on this repo.
- **Turbo cache saves even when the job fails.** `.github/actions/turbo-cache` restores at job start and
  saves in a separate `if: always()` step (`mode: save`). The combined `actions/cache` it replaced saved
  only on job success, and the Main full gate kept failing, so main never seeded a cache and every run
  rebuilt all 135 packages. Turbo caches only successful tasks, so a partial save is still correct.
  `scripts/ci/turbo-cache-prune.mts` first drops entries no `.turbo/runs` summary from this job named,
  so each save is the size of one run. Saves from PRs stay scoped to the PR ref (no cross-PR poisoning);
  push-to-main saves are the ones every PR and merge group restores.
- **Slimmer impact gate.** `scripts/ci/affected-lanes.mts` filters the turbo lanes to the changed
  packages and examples. Root build inputs (lockfile, workspace, turbo, tsconfig, biome, toolchain pins,
  vendored sources) run the whole workspace; workflows, root scripts and draft proofs are covered by the
  root checks in the same gate. `scripts/test/affected-lanes.test.ts` pins the skip logic. Dependents are
  not added yet: several packages carry pre-existing biome lint debt that a dependents sweep would surface.
- **Trace export.** `.github/actions/ci-trace` runs `scripts/ci/ci-trace.mts` to export per-step timings
  from each job, so queue time and run time can be compared before and after a change.
- **No serial PR jobs.** `artifact-trust` and `dev-cold-loop-gate` do their own checkout and install and
  read nothing from the PR impact gate, so they no longer `needs: pr-gate`. On a two-slot box that
  dependency left a slot idle while the gate ran, then queued both behind it. `ci-runner-image` and
  `secret-scan` skip the ts-autocode submodule checkout because neither installs packages.
- **Slot budget.** The box has two runner slots, so a job that gates nothing still delays every other
  run. Main full gate does not run on `merge_group` (it is not a required check, and the push to `main`
  re-runs the same tree), and `pr-offpath` diffs the PR merge commit against its first parent: when
  `affected-lanes.mts` prints nothing and no pin, submodule or package-boundary path changed, it skips
  install, the ts-autocode surface tests and `build:packages` and frees its slot in seconds.

## Frozen proofs and live-repo tests

`scripts/run-tests.ts` skips a frozen proof test that scans the live repo when its promoted package keeps
the maintained copy. The S0-04 codegen proof flagged ci-vercel's non-protobuf `src/_generated` files as
drift; `packages/schema-tools` already handles them, and the frozen proof cannot be edited.

## Runner image base digest

`packages/ci-gh-actions/deploy/ci-runner/build.sh` checks the pinned `debian:bookworm-slim` digest with
`scripts/ci-runner-verify-base-digest.mts` (anonymous Docker Hub registry API, digest compared against the
`docker-content-digest` header). `docker manifest inspect` from the worker image's Debian `docker.io` CLI
rejects that OCI index because its attestation children are OCI manifests, which failed the
`CI runner image (mise oci)` job on every dispatch. `scripts/test/ci-runner-image-contract.test.ts` pins
the check offline with a synthetic registry; `HOBO_CI_VERIFY_BASE_DIGEST=1` runs it live.
