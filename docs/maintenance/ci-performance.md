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
  `scripts/ci/turbo-cache-prune.mts` (node builtins only) runs first as a workflow step: it keeps every
  entry a `.turbo/runs` summary from this job named and stamps it used, keeps other entries used within
  `HOBO_TURBO_CACHE_KEEP_DAYS` (default 7), and drops the rest. It outputs `save=false` when no task
  missed the cache and left an entry, and the save step is skipped, so a fully cached run never starts
  the save composite (whose `actions/cache/save` resolve once timed out for 2 minutes). Keeping only the
  entries one run touched shrank main's cache to an affected-only run's handful of packages, and the next
  run rebuilt the rest cold. Saves from PRs stay scoped to the PR ref (no cross-PR poisoning);
  push-to-main saves are the ones every PR and merge group restores.
- **Slimmer impact gate.** `scripts/ci/affected-lanes.mts` filters the turbo lanes to the changed
  packages and examples, including the packages inside a pnpm-workspace group such as
  `packages/providers/<name>` (the groups are read from `pnpm-workspace.yaml`; before that, any change
  under a group read as a removed package and ran the whole workspace). Root build inputs (lockfile, workspace, turbo, tsconfig, biome, toolchain pins,
  vendored sources) run the whole workspace; workflows, root scripts and draft proofs are covered by the
  root checks in the same gate. `scripts/test/affected-lanes.test.ts` pins the skip logic. Pricing is the
  bounded exception: `packages/pricing/**` selects `--filter=...{./packages/pricing}` so CI, dispatcher,
  broker, cloud, and other manifest dependents run whenever the quote kernel changes. Other packages keep
  exact filters because several carry pre-existing biome lint debt that a general dependents sweep would surface.
- **Trace export.** `.github/actions/ci-trace` runs `scripts/ci/ci-trace.mts` to export per-step timings
  from each job, so queue time and run time can be compared before and after a change. The script
  imports node builtins only, because the step also runs on jobs that skipped or failed `pnpm install`
  (an inert PR diff skips install in the off-path job). With `zod` it failed `ERR_MODULE_NOT_FOUND`
  there and turned a skipped job red (#1653's run 41583817166). `scripts/test/ci-trace.test.ts` pins
  the import rule; the hand-written parser emits byte-identical spans and summaries.
- **No serial PR jobs.** `artifact-trust` and `dev-cold-loop-gate` do their own checkout and install and
  read nothing from the PR impact gate, so they no longer `needs: pr-gate`. On a two-slot box that
  dependency left a slot idle while the gate ran, then queued both behind it. `ci-runner-image` and
  `secret-scan` skip the ts-autocode submodule checkout because neither installs packages.
- **Slot budget.** The box has two runner slots, so a job that gates nothing still delays every other
  run. Main full gate does not run on `merge_group` (it is not a required check, and the push to `main`
  re-runs the same tree), and `pr-offpath` diffs the PR merge commit against its first parent: when
  `affected-lanes.mts` prints nothing and no pin, submodule or package-boundary path changed, it skips
  install, the ts-autocode surface tests and `build:packages` and frees its slot in seconds.
- **PR jobs skip what the diff cannot reach.** `artifact-trust` and `dev-cold-loop-gate` each test a
  fixed subject (the artifact trust proof's `publish-verify.test.ts` with the root `vitest.config.ts` and
  its setup files; `scripts/ci/dev-cold-loop-timing.mts`). `scripts/ci/job-scope.mts` walks those
  entries' relative imports and `new URL(…, import.meta.url)` references, adds every workspace package the walk
  enters or names plus those packages' workspace dependencies, and prints `run=false` only when no path
  in the PR merge commit's diff lands in that set. Workspace-wide inputs, `.github/`, pins, submodules,
  the runner image and a computed or unresolvable import always run the check. A skipped step keeps the
  required check green, as on `pr-offpath`, and the job frees its slot after checkout. The script imports
  node builtins only, since it decides whether to install; `scripts/test/job-scope.test.ts` pins the walk
  and checks that both real entries scope without giving up. #1652 (ci-gh-actions) and #1653
  (`scripts/run-tests.ts`) would have skipped both jobs: 1–3 slot-minutes each per run, excluding stalls.

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

The same job runs inside a `--network bridge` container, where `127.0.0.1:5000` is the container's own
loopback rather than the host's local registry, so `mise oci build` failed after six seconds. `build.sh`
publishes the `hobo-ci-registry` container on a free loopback port (the box already had something on
5000, so a fixed `-p 5000:5000` failed with "port is already allocated"), pushes over that port, reads
the registry at the container's bridge address from inside a job container, loads
the OCI layout with skopeo (now in `system-packages.txt`) or, without it, pushes the layout to that
registry with `mise oci push --image-dir` and has the daemon `docker pull` it (the box's classic image
store cannot `docker load` an OCI layout), and retags
`hobo-ci-worker:local` only after the live preflight contract passes. Its change detection greps a
depth-2 diff of `HEAD~1`; before, it used `rg`, which the worker does not ship, so it never fired.

## Reading a main failure

`gh run view --log` and the web viewer can drop the tail of a long step, so a step can look as if it
stopped inside `test:unit` when Vitest passed and a later command failed. Read the raw job log instead:
`gh api --allow-escape-sequences repos/Hobo-Labs/HoBo/actions/jobs/<job-id>/logs`. That is how the
"unit test hang" on main turned out to be the live examples-console Cloudflare scenario failing in the
offline `test:behavior` lane; it now runs only under cucumber's `live` profile. Main full gate has a
20-minute job limit and step limits, `scripts/run-tests.ts` kills a Vitest run after
`HOBO_TEST_RUN_TIMEOUT_MS` (default 600000), and main's workspace tests are affected-only:
`scripts/ci/dependent-tests.mts` runs changed packages whole and, in each dependent, only the test
files whose import closure reaches a changed file. Its first output line is the plan; to see why a
dependent's file was picked, pipe the same diff into the script locally without `--run`.

If Vitest's `Duration` is far below the wall time between its `Start at` and its summary line, the host
paused: both of Vitest's numbers come from the monotonic clock, which a suspended box stops.
`scripts/run-tests.ts` prints `the wall clock ran Ns ahead of the monotonic clock` when the gap passes
30 s. Check the box's power and sleep settings before you tune Vitest.

Every `run-tests` lane also loads `scripts/lib/vitest-progress-reporter.ts` and Vitest's
`hanging-process` reporter. Every 30 s (`HOBO_TEST_HEARTBEAT_MS`) it prints `vitest progress: N/M files
done; running: <file> (<age>s)`, so a stuck file is named while it is stuck. A heartbeat that arrives
late on the wall clock but not on the monotonic one prints `the host was paused for about Ns`, which
places the pause in the log. The run ends with the ten slowest files. If the step dies with no summary,
the last heartbeat names what was running. If the log just stops, the box itself stopped.
