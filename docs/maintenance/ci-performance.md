# CI performance notes

How the self-hosted HoBo CI keeps PR gates fast, and where to look when it slows down.

- **Parallel isolated containers.** The box worker (`packages/ci-gh-actions/scripts/isolated-worker-daemon.mts`)
  runs up to `HOBO_CI_WORKER_SLOTS` jobs at once, subject to both slot and memory admission. Exact job names
  select light/standard/heavy hard container limits (3072/4096/6144 MiB); active, reserved and warm requests
  must sum within host/cgroup memory minus at least 2048 MiB reserve. On the 15989 MiB box that budget is
  13941 MiB, so three mixed classes can fit but three heavy jobs cannot. Job preflight derives the Node heap,
  serial turbo and `HOBO_TEST_MAX_WORKERS` from the admitted container limit; CI never exports
  `VITEST_MAX_WORKERS`, preserving single-worker config pins. Byte or inode usage above 85% triggers safe
  pruning before admission, and usage above 95% after pruning leaves the job queued. Inode and byte
  grants bin-pack against live `statfs` headroom (shared-root dedupe, measured peaks, 15s grant release);
  idle JIT listeners release after three minutes when the fleet mesh already holds the
  job, or after ten minutes when GitHub never assigns work
  ([finding 100](../ci/findings/0100-inode-grant-idle-reconcile.md)).
- **No shared database on the box.** The worker keeps its lease journal and webhook inbox in a local
  SQLite file (`@hobo/ci/sqlite`, `${XDG_DATA_HOME:-~/.local/share}/hobo-ci/worker.sqlite`) and polls
  GitHub every `HOBO_CI_JOB_POLL_MS` (2 s by default) for queued `runs-on: hobo` jobs, so CI does not stop when a hosted
  Postgres quota or webhook relay does. SQLite is the only store: the shared-Postgres option was removed
  with the hosted relay's database (ADR-0179 phase 7). `ci-store-contract.test.ts` runs the store
  contract against it; see `packages/ci/RUNNER-QUEUE.md` for the env vars.
- **Pinned SBOM scanner.** `syft@1.56.0` is pinned through mise for the hermetic runner image, so runner and release SBOM generation use the same reproducible scanner version.
- **Shared pnpm store.** The box worker bind-mounts one content-addressed store into every job container
  and sets `HOBO_CI_PNPM_STORE_MOUNTED=1`; `.github/actions/pnpm-store` reads that from the process env
  (an `if: env.X` expression never sees container env) and skips `actions/cache`. A self-hosted runner
  without the mount installs from the registry: a cold `pnpm install` measured ~21s, while restoring the
  1.3 GB cache archive took 31–52s and main's save took 142s. Only GitHub-hosted runners use the cache.
  **`hobo-ci-deps:local` must stay selectable after a worker toolchain promotion** — a label-only lag on
  `hobo.ci.toolchain` used to drop `HOBO_CI_DEPS_LAYER`, force a ~5m install, and leave S0 cold
  ([finding 83](../ci/findings/0083-main-full-gate-paid-for-missing-deps-layer-and-trunk-serialization.md)).
  Trunk admission now prefers `merge_group` over `push` at the same rank so merge-queue shards are not
  stuck behind a long main push gate when trunk slots are scarce (finding 83).
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
  under a group read as a removed package and ran the whole workspace). Root build inputs (workspace, behavior-changing turbo config, tsconfig, biome, toolchain pins,
  vendored sources) run the whole workspace. A `mise.toml` or `mise.lock` diff that only touches a tool no
  Main-gate full-history gitleaks uses `scripts/ci/gitleaks-main-scan.mts` with a committed baseline
  (`docs/ci/gitleaks-main-baseline.sha`) so `workflow_dispatch` scans `baseline..HEAD` without
  `--refetch`, and raises full-scan timeouts when no baseline applies. Package task runs (`gitleaks`, `shellcheck`, `syft`; the list is explicit in the script) does not
  ([finding 81](../ci/findings/0081-a-ci-only-tool-pin-planned-the-whole-workspace.md)). Scripts-only root manifest edits and root `//#` task edits
  stay scoped by comparing root files with the diff base; `globalDependencies` additions and removals
  run the whole workspace because they change every task's hash inputs. Missing or invalid base content
  fails closed. A lockfile-only diff runs everything, but lockfile plus package
  paths stay scoped to those packages. Workflows, root scripts and draft proofs are covered by the
  root checks in the same gate. `scripts/test/affected-lanes.test.ts` pins the skip logic. Dependents are
  not added yet: several packages carry pre-existing biome lint debt that a dependents sweep would surface.
  The impact job and its merge-group S0 step have a 20-minute limit so large affected sets can finish
  on a cold worker; a timeout cancels the gate and does not count as a passing check.
  Root typechecking builds the Redis-compatible package first because the Upstash provider sources
  referenced by root tests resolve its declarations from `dist` on a clean worker.
- **Workspace duration table typing.** `scripts/ci/workspace-test-durations.mts` uses pins-json tag narrowing so root `typecheck:root` accepts the JSON leaf parser on CI.
- **Main full gate workspace sharding.** `main-gate-plan` (runner image only; install-free mise turbo — [finding 93](../ci/findings/0093-main-sub3m-plan-pickup-shards.md), [finding 92](../ci/findings/0092-main-plan-parallel-deps-affected-shards.md)) resolves the last-green
  base and prints a duration-balanced shard matrix capped by `HOBO_CI_FLEET_CAPACITY` (default four
  parallel slots; see [finding 86](../ci/findings/0086-main-workspace-shards-fleet-parallel-cap.md)).
  Each shard packs several workspace groups (`scripts/ci/workspace-test-durations.json`, target 180s
  slowest shard when slots allow; weights refreshed from turbo build+test seconds in
  [run 42951579615](https://github.com/Hobo-Labs/HoBo/actions/runs/42951579615) so
  `packages/cli`, `packages/hobo`, and `packages/ci-gh-actions` land on different shards).
  While `main-gate` runs S0, unless the push widens the gate (lockfile or root config), workspace
  shards run `dependent-tests` against the last-green main SHA with `turbo run test --affected`,
  `TURBO_SCM_BASE`, and the box-local shared `hobo-turbo-cache` directory (`TURBO_CACHE=local:rw`
  when no remote token). `ci-runner-preflight` sizes `HOBO_TURBO_CONCURRENCY` from cgroup headroom
  and learned peaks for `Main workspace test shard *` (4096 MiB standard floor).
  `main_workspace_tests` starts after the plan job only,
  links the deps layer first, and skips pnpm store/install on a layer hit; when the plan emits
  `shards=[]` the shard job is skipped and finish passes without workspace legs
  ([finding 139](../ci/findings/0139-main-gate-finish-empty-shard-matrix.md)). S0 uses
  `--external-workspace-tests` when affected. Gitleaks stays in `main_gate_finish`
  ([finding 85](../ci/findings/0085-main-full-gate-workspace-shards-and-last-green-base.md)).
  Box dispatch latency (early `dispatchPending`, poll-triggered tick, shard index ordering,
  `hobo_ci_job_reserved`) is [finding 99](../ci/findings/0099-main-gate-job-pickup-latency.md);
  poll coalesce strand fixes stay [finding 87](../ci/findings/0087-poll-coalesce-stranded-queued-jobs-on-github.md) / [#1819](https://github.com/Hobo-Labs/HoBo/pull/1819).
- **Separate workspace budgets.** A cold S0 validation took almost 19 minutes in run 42312939250,
  leaving too little of its 20-minute job for dependent workspace tests. PR and merge-group validation
  now delegate workspace tests to bounded shards; the PR's build, lint, schema, and contract lanes
  get a separate job. `dependent-tests.mts` assigns each whole suite or dependent subset to exactly one
  shard and verifies that a repo-wide run discovers every Turbo test workspace. The validation job
  plans the matrix (`--plan-shards=8`): one shard per four planned suites, eight for a repo-wide plan or
  whenever the plan is missing. Each shard splits by its position in the matrix GitHub built, so the
  list cannot drop a suite
  ([finding 82](../ci/findings/0082-eight-test-shards-started-for-plans-of-zero-to-four-suites.md)). Shards prefer the
  validation job's same-run Turbo cache but run their complete selected plan on a cache miss. The required
  `PR impact gate` fails unless validation, every workspace shard, and the event's other required lanes
  succeed. The PR merge base is pinned from the event's base SHA and passed to every job, so a later
  target-branch update cannot silently change their test scope. `scripts/test/merge-group-gate.test.ts`
  covers failed, cancelled, skipped, and missing results.
- **Trace export.** `.github/actions/ci-trace` runs `scripts/ci/ci-trace.mts` to export per-step timings
  (artifact names include a per-matrix `disambiguator`, usually `matrix.shard`, so parallel workspace shards
  do not collide on `upload-artifact`)
  from each job, so queue time and run time can be compared before and after a change. The script
  imports node builtins only, because the step also runs on jobs that skipped or failed `pnpm install`
  (an inert PR diff skips install in the off-path job). With `zod` it failed `ERR_MODULE_NOT_FOUND`
  there and turned a skipped job red (#1653's run 41583817166). `scripts/test/ci-trace.test.ts` pins
  the import rule; the hand-written parser emits byte-identical spans and summaries.
- **Relay and worker traces.** The box worker exports its own OpenTelemetry spans when an OTLP
  endpoint or `HOBO_CI_TRACE_FILE` is set: every GitHub call that changes something (runner created,
  runner deleted, run force-cancelled or re-run) and every structured log event, with a job's pickup
  split into queue, container start and runner registration. A run's trace id comes from its run id,
  and `ci-trace.mts` now uses the same id, so the job's Turbo spans and the worker's spans for that
  run form one trace. Runs were being cancelled with nothing recording by whom; a cancelled run whose
  trace has no `force-cancel` span was not cancelled by the worker. Settings and the span list are in
  [`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md).
- **Regenerated proxy bundle passes the generated-file guard.** `sandbox-proxy-bundle.ts` embeds relay
  sources, so changing them regenerates it with no generator change to stage, which the guard used to
  refuse. It now runs `generate-proxy-bundle.mts --check` for that file and allows the commit only when
  the bundle on disk is exactly what the generator emits.
- **Image builds read the checkout's pins.** `build.sh` runs inside a job container that carries the
  tool pins of whichever commit last built `hobo-ci-worker:local`. After a pull request pinned `syft`
  and rebuilt the shared image, `mise install --locked` failed on every branch without that pin
  (`syft@1.56.0 is not in the lockfile`, release run 42741596338). The script now ignores the image's
  baked `/etc/mise/config.toml`, and `scripts/test/ci-runner-image-contract.test.ts` pins that it does
  so before its first mise call.
- **A trace upload never fails a gate.** The `ci-trace` action's artifact upload is diagnostics. When
  GitHub's artifact service answered with an HTML error page, the upload retried for ten minutes and
  failed Main full gate after every gate in it had passed (run 43094500900), which also held back the
  release. The upload step is `continue-on-error`; the trace export, which is this repo's code, still
  fails loudly.
- **No serial PR jobs.** `artifact-trust` and `dev-cold-loop-gate` do their own checkout and install and
  read nothing from the PR impact gate, so they no longer `needs: pr-gate`. On a two-slot box that
  dependency left a slot idle while the gate ran, then queued both behind it. `ci-runner-image` and
  `secret-scan` skip the ts-autocode submodule checkout because neither installs packages.
- **The cold dev loop runs on every runner kind.** Its fallback for a runner without
  `hobo-ci-worker:local` was `sudo unshare --net`, and ARC pods (`hobo-runner-*`) have Docker but no
  `sudo`, so the job died with `sudo: command not found` before any test ran (runs 43019469092 and
  43036897317), depending only on which runner picked it up. Self-hosted runners now pull the
  content-keyed worker image from GHCR first and run it with `--network=none`; GitHub-hosted runners
  keep the `sudo` namespace; a runner that can do neither fails with an `::error` naming why. The
  pull had never run anywhere: `ensure-ci-worker-image.mts` probed GHCR with the raw `GITHUB_TOKEN`
  as a bearer, which the registry refuses, so every probe read "absent" (run 43043419831 logged that
  two seconds before `docker pull` fetched the same tag). It now asks `docker manifest inspect`.
  The pull's token reaches only the pull: the cold loop refuses to boot with `GITHUB_TOKEN` set, so
  the step takes it as `HOBO_GHCR_PULL_TOKEN` and unsets it before either isolated run.
- **Slot budget.** The box has two runner slots, so a job that gates nothing still delays every other
  run. Main full gate does not run on `merge_group` (it is not a required check, and the push to `main`
  re-runs the same tree), and `pr-offpath` diffs the PR merge commit against its first parent: when
  `affected-lanes.mts` prints nothing and no pin, submodule or package-boundary path changed, it skips
  install, the ts-autocode surface tests and `build:packages` and frees its slot in seconds.
- **Live data engines.** `data-live` runs the data packages' suites against a real PostgreSQL 16 and a
  real MongoDB 8 replica set (`pnpm run test:data-live`). A fleet job is a container on the host
  engine, so `scripts/ci/data-live-servers.mts` starts the two servers as *sibling* containers on the
  `bridge` network the job container is on and hands the suites their addresses there: a published
  port would bind the host's loopback, which is not the job's, and the fleet has no `services:`. The
  containers carry the lane's own label (`hobo.data-live`), not the worker's — the daemon removes
  lease-less containers under `hobo.ci/isolated` — and are bounded at 1 GiB each because they sit
  outside the job's cgroup. They are not started with `--rm`: when a server dies during start-up the
  start step prints its logs before removing it, and when the step itself is killed the failure step
  prints them.
  Teardown does not rely on the job surviving. An `always()` step removes the containers; a job that
  is killed never runs it, so each server runs under `timeout` and stops itself after 25 minutes
  (longer than the 20-minute job, so never under a live one), and every job's preflight removes
  containers of the lane older than 30 minutes. A leaked pair therefore holds memory for at most 25
  minutes and disk until the next job starts on that box.
  The job is in the worker's `heavy` memory class (it installs, builds about two dozen packages and
  runs five suites). The two servers are **not** counted by admission — up to 2 GiB beside the job
  that the daemon does not see — which the heavy reservation is meant to leave room for; this has
  not been measured on a box.
  The images are digest-pinned in `packages/data-core/deploy/live-engine-images.json`.
  MongoDB is started with `GLIBC_TUNABLES=glibc.pthread.rseq=1`: MongoDB 8's allocator misuses
  restartable sequences on Linux 6.19 through 7.0.13 (SERVER-121912), recent 8.0 releases refuse to
  start there, and until 8.0.37 they also refused on Ubuntu kernels that already carry the fix — the
  lane's first run failed on a GitHub-hosted runner for exactly that. With glibc owning rseq the
  allocator falls back to per-thread caches and the host's kernel stops mattering.
  The suites do not run through turbo: it passes `HOBO_*` through without keying its cache on them,
  so a cached offline result would replay as a live pass. A green exit is not taken as proof either:
  the live tests skip themselves when their variable is missing, so the step ends with
  `data-live-servers.mts verify`, which reads the run's output and fails unless each of the five
  packages printed a summary and no test in it was skipped, failed or left todo. The start step
  prints the server versions and addresses the run was against. Four of these packages run under the root
  vitest config and `packages/trails` under its own; both apply `HOBO_TEST_MAX_WORKERS` through
  `capVitestWorkers`. The step used to export the cap as `VITEST_MAX_WORKERS`, which Vitest lets
  override every config (single-worker pins included) and which `scripts/test/memory-env.test.ts`
  forbids in any workflow. The job is scoped like `artifact-trust` (below) to the live test files, so a
  pull request that cannot reach the data engines frees the slot after checkout
  (`scripts/test/job-scope.test.ts` pins the entry list and checks it against the repository, so
  changing the entries means changing that test); a manual dispatch always runs it, whatever its tip
  commit is. It never runs on the schedule or on `merge_group`: it needs a runner that can start
  containers, and a scheduled run would fail on its own whenever none is available.
  On a GitHub-hosted runner the servers are up in under half a minute and the suites take about a
  minute and a half.
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

## The ci-gh-actions test suite

`packages/ci-gh-actions/vitest.config.ts` runs its test files in two projects. `shared` (everything
but five files) sets `isolate: false`, so the files share their worker's module graph instead of each
re-importing the `@hobo/*` graph; `restoreMocks: true` undoes a spy a test leaves, and
`test/setup/no-leaked-handles.ts` fails a file that leaves a timer, server, socket or child process
running in the shared worker. `isolated` keeps per-file isolation for the files that load Docker, Pact
or Dagger tooling, which could not be run in a shared worker where this was measured. A globalSetup
(`test/setup/tmpfs-tmpdir.ts`, declared once at the root, so it runs once) moves the tests' `TMPDIR` to
`/dev/shm` when it has at least 512 MiB free and can run a file from there, because every SQLite store
the tests open waits on an fsync per commit; `HOBO_CI_TEST_TMPFS=0` keeps the disk.

The suite also no longer runs pnpm (the `project` script is checked statically and its built CLI
started once), no longer starts a Postgres container only for `SELECT 1` (`ci-store-contract.test.ts`
runs the same pinned image), stalls 1 s less in the bootstrap shutdown case, starts no cleanup
`stop` for a local runner already stopped, keeps the daemon import cases from running a build outside
turbo, removes the fake docker directories it made, and declares `@hobo/stations`, so a change there
now selects the two ci-gh-actions tests that load it.

A later merge (#1792) brought the pnpm case back, and with it the pre-commit timeouts: `pnpm --filter
@hobo/ci-gh-actions project inspect` costs about 1.1 CPU-seconds for two cold node starts, and with
the hook's turbo run sharing the CPUs it reached the 10 s default (10.1 s and 10.2 s at a load of ~30
on 4 CPUs) and left its pnpm process running in the shared worker. It is the two cases above again.
The built CLI's start is a third of that CPU (3-4 s at that load, 9 s once at a load of 44), so its
case's budget now covers the child's own 30 s bound instead of the 10 s default, and the case's
`signal` stops the child if the case is cancelled anyway.

`relay-mcp.test.ts`'s journal-bounds case seeds a neighbour's rows between an account's events to
prove a read reaches past the old 10,000-row bounded look. Each seeded write commits on its own, and
21,500 of them were 85% of the case (1.8 of 2.2 s idle); with the hook's turbo run sharing 4 CPUs
with 16 busy loops it took 9-17 s and passed 10 s in two of three runs. It now seeds 10,100 rows,
just past the bound: 1.2 s idle, 4.3-6.4 s under the same load.

Measured back to back on one CPU (`taskset -c 0`, `CI=1`, `HOBO_TEST_MAX_WORKERS=1`, `TURBO_HASH` set
as under turbo, TMPDIR on disk) on a shared host: 145.6 s wall and 73.3 s CPU before (load 28.0 →
34.1), 44.9 s wall and 28.2 s CPU after (load 33.2 → 32.4).

## The hobo package's child-process tests

About 80% of `@hobo/hobo`'s test time went to four files that start the `hobo` binary as child
processes, each spending seconds loading the CLI before doing any work. The suite now starts fewer of
them, and each of the rest from the built `dist` where TypeScript loading is not what it tests:

- `starter-deployment-end-to-end` runs the packaged `up` → HTTP → `down` lifecycle for one starter
  (fullstack). The four starter trees are byte-identical, and `packages/cli/test/starter-end-to-end.test.ts`
  runs `new → codegen → build → /proof` for all four in-process.
- `persistent-local-deployment` walks one deployment through serve, reuse, edit and `down`, and
  expires one `--anonymous` deployment. `--temporary` takes the same TTL rule (`wantsAnonymousMode`), and
  `self-hosted-broker.test.ts` checks in-process, with the worker start stood in for, that the persistent
  lane asks for the TTL under each flag. Its cleanup, and the starter test's, runs `down` only while a
  receipt is left.
- `composed-temp-dirs` runs its fixture on bare node against `dist`, in seven cases instead of nine.
- `bin-opensesame` keeps `node --import tsx` only for the case about relaunching with the loader.
- `ci-runs` passes its no-op `sleep` from the shared harness, and `runtime-requirements` gives the oci
  placement case a ready stub host instead of equipping kubectl, asserting only that it gets past the
  runtime check.
- `login-device-grant` keeps the cases only the command shows; RFC 8628 protocol cases are in
  `oidc-device-grant.test.ts`.

- The package's `pretest` builds it outside turbo (`scripts/ensure-built.mts`), so a local run does
  not test a stale `dist`.

Measured back to back on one CPU (`taskset -c 0`, `CI=1`, `HOBO_TEST_MAX_WORKERS=1`) on a shared host,
whose load rose through both runs: 896.5 s wall and 461.8 s CPU before (load 3.8 → 24.6), 460.4 s wall
and 241.9 s CPU after (load 24.6 → 37.3). CPU is the steadier figure. The wasm files, `fileParallelism`,
and the CLI's eager imports are left for later changes.

## Changed paths on stdin

`job-scope.mts`, `dependent-tests.mts` and `impact-classifier.mts` read the changed paths that a
`git diff --name-only …` pipe gives them through `scripts/lib/read-stdin.mts`, not `readFileSync(0)`.
In Node 22, `import process from "node:process"` builds that module's exports from every property of
`process`. That opens `process.stdin`, and on a pipe libuv sets O_NONBLOCK on fd 0. If node reaches
the read before git writes, `readFileSync(0)` fails with `EAGAIN`. `artifact-trust` failed that way in
14 s on #1772, and the same job passed on other PRs. After an empty read, `readStdin` sleeps 10 ms on
`Atomics.wait` and reads again. It gives up only when nothing has arrived for 30 s.
`scripts/test/read-stdin.test.ts` runs the three scripts with a writer that starts one second late,
plus a late write larger than the 64 KiB read chunk. It keeps a `readFileSync(0)` control that must
still fail with `EAGAIN`, so the harness is shown to reproduce the failure; the control skips itself
on a Node/platform where fd 0 stays blocking, since the quirk it pins is libuv's, not the scripts'.
`scripts/lib/read-stdin.mts` is in the impact classifier's `SELF_PATHS`: changing the reader the
classifier itself reads stdin through counts as a classifier self-change. Edits to the reader or its
three callers also select `scripts/test/read-stdin.test.ts` + `job-scope.test.ts` in
`scripts/relevant-check-policy.ts`, since the broad `test:scripts` lane is not part of the PR gate.

## Planner

`scripts/ci/dependent-tests.mts` plans a changed path outside every package (the root vitest config, a
shared setup file, a doc) by asking each other package whether its vitest config or a test reaches it.
It used to skip any package whose `test` script is not plain `vitest run` before asking, so a root
`vitest.config.ts` change ran `packages/hobo` and missed `packages/cli`
(`pnpm run build && vitest run`), whose config merges the root one; `test/setup/*` had the same gap.
Such a package is now asked like any other and runs whole when it is reached, since its script cannot
take a file list. The same question is now asked of every package that neither changed nor depends on
one, not only when a path outside every package changed: a package can import another's source by
relative path without depending on it, as `packages/stations/test/ci-routing.test.ts` imports
`../../broker/src/budget-signals.js` without depending on `@hobo/broker`, and a change to the imported
package used to skip that test. Only a concrete reach counts there.

A bare `"./"` or `"../"` string literal is an edge to its directory only where it can be a path.
`entry.startsWith("./")` in `packages/core/src/plugin-manifest.ts` read as reaching every file of
`@hobo/core`, so any core change ran 53 whole suites and 53 subsets; a change to
`packages/core/src/_generated/actor_host_port_pb.ts`, which no module of core imports, planned 13 whole
suites and 14 subsets when the edge was dropped. Those figures are a measurement of that day's
workspace, not something a test holds: `scripts/test/dependent-tests.test.ts` pinned the three counts
and went red on main when three packages the file does not reach were added. The case now counts no
package. It asserts that no module of `packages/core/src` reaches the generated file (with the `./`
edge back, `plugin-manifest.ts` and `index.ts` do, and the failure names them), that `packages/core`
runs whole, and that `packages/broker`, `packages/contracts` and `packages/events`, which import
`@hobo/core` and name nothing wider, are skipped. Adding a package changes none of that. The same
file's root-config cases list by name the packages whose vitest config merges the root one
(`packages/cli`, `packages/hobo`); that list changes when such a package is added, and the failure
says which list to edit. Nothing in CI runs this test file: `test:root` runs only `test/`, the unit
lanes skip `node:test` files, `scripts/relevant-check-policy.ts` selects `read-stdin.test.ts` and
`job-scope.test.ts` for a planner change but not this file, and `test:scripts` is in no workflow. Run
it by hand after changing the planner: `node --import tsx --test scripts/test/dependent-tests.test.ts`
(or `pnpm run test:scripts` for the whole directory), with `turbo` on `PATH` for the two cases that
read the real turbo graph. The edge is dropped
only where the literal is provably a string test: the first argument of `startsWith`, `endsWith`,
`includes`, `replace` or `replaceAll` (what is searched for), an operand of `===`, `!==`, `==` or
`!=`, or a `case` label. Everywhere else it stays (`new URL("../", import.meta.url)` with or without a
comment or a cast, `join(__dirname, "./")`, `resolve(import.meta.dirname, "../")`, `cwd: "../"`,
`"../" + name`, and a replacement value such as `s.replace("@/", "../")`, which may be a path), and
it is the directory itself, not the `index.ts` inside it. The rule reads text, not a syntax tree,
since the planner runs on Node builtins before `pnpm install`; what it cannot tell keeps the edge. A trailing `// …` comment
between a call and the literal is read past before the literal is judged, so it can neither hide a
string test nor fake one; a `//` inside a string on that line is not a comment, and a literal that
sits in a trailing comment is still an edge. A template literal with a substitution
(`` `../${name}` ``) is no edge, as on main: the planner cannot tell what it names. An unknown or
unmapped change still runs everything.

A package's `package.json`, its `turbo.json`, its `tsconfig.json`, every tsconfig one of its scripts
names by path (`tsc -p tsconfig.build.json`, `tsc -p config/tsconfig.types.json`), whatever those
extend inside the package, and the `tsup.config.*` or `vite.config.*` beside the manifest when a script
runs that tool are inputs to whatever imports the package: `exports`, `type`, the task definition and
the compiler and bundler options decide what an importer gets. An `extends` that leaves the package
(the root `tsconfig.base.json`) is a path outside every package and is planned as one. No other
bundler config is followed (`esbuild.js`, a rollup config), nor a config a bundler config imports. A closure that enters a package reaches them, and
entering means importing it or naming one of its files; a directory read does not
(`join(here, "../../connectivity/contracts/pacts")` reads data the manifest does not shape, so only a
change under that directory selects the reader). Before this, nothing led from an `@hobo/x` import to
`packages/x/package.json`; the bare `./` edge hid that for core and cli, and without it a
`packages/core/package.json` change planned 13 whole suites and 14 subsets. It now plans 70 and 56, a
`packages/cli/package.json` change 6 and 3, and a `packages/policy/package.json` change 25 and 13
(5 and 8 before, when its importers were never selected).

The planner's own time matters: `scripts/test/read-stdin.test.ts` runs it behind a late writer under
a 20 s guard, in the same step as the root type-check and the root tests. On an idle runner that step
took 12 s in all; on a busy one the planner alone passed 20 s, was killed (`null !== 0`) and failed
"PR impact validation" (run 42824059139). Eight busy loops on four cores reproduce it. The test sent
`docs/a.md`, and a plan for a path outside every package walks every package's tests: about 3 s on
main and 2 s on this branch when idle. Two changes answer it. The test now sends `pnpm-lock.yaml`,
which plans the whole workspace without walking a test (0.2 s) and still proves the late path arrived,
since the reason names it and an empty read says "empty diff". And the walk is about a third cheaper:
a path's package is found by walking up its directories instead of scanning every workspace, a path
many files name is resolved once, and the comment strip no longer backtracks over blank lines.
`dependent-tests.test.ts` ("the walk's cost") counts workspace comparisons and file lookups on a
40-package fixture, since a time budget would be the same flake again.

`pnpm-lock.yaml` plans the whole workspace only when it is the whole diff. Beside changed package
paths it widens nothing: the plan is the one those paths give, so `packages/core/package.json` with
the lockfile plans what `packages/core/package.json` alone does. That rule is `affected-lanes.mts`'s
(a lockfile-only diff runs everything; Turbo still hashes the lockfile into every task), and the
planner takes it unchanged.

`scripts/ci/plan-replay.mts` replays the planner over the last N main commits (`--count=100`), each
with its parent as the base, and prints whole/subset counts. `--before=REF` compares against the
planner at REF. `--check` reads a second import graph from the syntax tree
(`scripts/lib/test-import-specifiers.mts`) and fails if a test whose imports or vitest config reach a
changed file is not in the current planner's plan; the misses of the planner at `--before` are printed
and do not fail the run. Run against the old planner, it reports the 41 `packages/cli` tests a root
config change missed. The check graph covers import edges only, plus one manifest edge: an import of a
workspace package by name reaches that package's `package.json` and `tsconfig.json`. Path literals,
directories and data files a test reads, spawned programs and a tsconfig only a script names are edges
of the planner that `--check` does not check; `scripts/test/dependent-tests.test.ts` pins those on a
fixture and on the real tree, and `scripts/test/plan-replay.test.ts` pins the check graph. The
real-tree cases name packages and count none, so adding a package the change does not reach leaves
them alone (the Planner section above says what each asserts).

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
the check offline with a synthetic registry; `HOBO_CI_VERIFY_BASE_DIGEST=1` runs it live. The same
contract file expects every `mise.lock` tool (including `syft`) to be installed and version-probed in
`Dockerfile.monolithic` when the OCI path is not used. Until every box worker retags a syft-era image,
`ci-runner-preflight` also exports checkout `mise bin-paths` onto `PATH` when an older tag already ran
`mise install` but did not ship the new tool directory.

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
The optional GHCR push step calls `scripts/ci/push-ci-runner-image-ghcr.mts`, which retags
`hobo-ci-worker:local`, pulls, or rebuilds on the runner executing the push and emits a notice
instead of failing when the version tag is absent on that box. The script and its tests stay
Biome-formatted (`pnpm run lint:code`).

## Which runner a run uses

Every routed workflow starts with a **Route runners** job on a GitHub-hosted
machine. The run's jobs ask for the label it chose: the fleet (`hobo`, or
`hobo-trunk` for trunk events) while it is taking jobs, an enrolled local box
(`hobo-local-host`) when it is not, and `ubuntu-24.04` when neither is. A
backend is taking jobs when a runner took a job for its label in the last 15
minutes, no such job has waited 120 seconds, none it took in the last hour
had, and fewer than 4 are waiting. The hour is deliberate: the probe is one
small job, and a run sent to the fleet because a runner took the probe at once
waited 17 minutes for runners. The route job reads the three longest finished
runs of the last hour to find such waits after their run has ended. The **Fleet probe** workflow, started by each CI
run, keeps a pickup on record for every label that has a runner behind it. A
label that is down holds one probe job that goes on waiting, which reads as a
label past its limit; it has its own concurrency group, so it does not hold
up the probe of another label. After a quiet spell a run waits up to 60 seconds for that probe before giving
up on the fleet. Runs that start together take turns: one that started just
after another that has not chosen yet goes to GitHub-hosted. The two required
gates are always GitHub-hosted. A run that says `runner: ubuntu-24.04 (github)`
in its Route runners log was sent there for one of those reasons, and the same
line says which.

The deps image publisher samples Docker headroom with bind-mount and host-root
fallbacks ([finding 94](../ci/findings/0094-deps-publisher-docker-headroom.md)).
One job in `hobo-ci.yml` is never routed: **CI deps layer (pnpm)** always asks
for the fleet, because it builds the deps image in the box's own Docker
context. No gate waits for it.

On the fleet, the deps layer is linked only into package directories the
checkout still has. A layer built before a package was removed from the tree
used to recreate that package's directory with only `node_modules` in it, and
the package-layout check (`konsistent`) then failed for a package that no
longer exists.

On a GitHub-hosted machine a job runs the same steps with no deps layer and a
cold pnpm store unless main has saved one, so installs are slower and the
tests are not. Jobs that run package tests download the image's pinned headless
shell first, and one storage test that needs the image's user is skipped
there. With a Docker engine present, the Postgres container tests run rather
than skip. The cold dev loop is the one job that differs: with no worker
image, it runs in a network namespace whose only interface is loopback.
Repository variable `HOBO_CI_ROUTE=fleet` turns routing off. The runbook is
"Runner routing" in [`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md).

## Running a pull request's CI on your own machine

The slowest part of a pull request is often not the tests but the wait for a
runner. `pnpm ci:attest run` runs the covered CI jobs on the machine you are
sitting at, signs the result, and `pnpm ci:attest publish` pushes that record
to the `ci-attestations` branch. The **Route runners** job of the next CI run
verifies the record and the covered jobs are skipped: they need no runner, and
the few jobs left go to GitHub-hosted machines.

Covered: `pr_gate_validation`, `workspace_tests`, `pr_affected`, `pr-offpath`,
`artifact-trust`, `ci-guard` and `secret-scan` in `hobo-ci.yml`, and
`release-contract` in `release-hobo.yml` when no release image is affected. Not
covered: `ci-runner-image`, `ci-deps-image`, `dev-cold-loop-gate`, the route
job and the gates.

The record is bound to one git tree and one base tree, and it is signed with a
key listed in `.hobo/ci-attestors.json`. The workflow reads that list at the
pull request's base commit, never from the pull request itself. The local run
executes the same commands as the workflow jobs, read from
`scripts/ci/attested-jobs.json`; a test fails when that file and a workflow
drift apart. When `main` changes a covered job, that test fails on a branch
rebased onto it until the file is updated, so a local run never signs for an
older version of a job. It has caught two such changes already: the stray-package
prune added to the S0 gate set, and the DCO check that now skips merge
commits.

What this does not give you:

- It does not make a pull request more trustworthy than before. A
  same-repository pull request can already edit the workflow that tests it.
  Reading keys at the base commit only stops a pull request adding its own key.
- Whoever holds a trusted private key can make the covered checks pass without
  running them. Keep the list short. Every entry has an expiry of at most 90
  days, which the verifier enforces, and removing an entry only affects events
  whose base no longer lists it.
- The commands under test run as the same user as the key. Steps get an
  allowlisted environment and a scratch `HOME`, which is hygiene, not a
  sandbox: never attest code you would not give the key to.
  The attestation tests run inside those steps too (`agent:check` selects
  them for changes to what they guard), so they set every variable they
  check and assume nothing about the host's environment.
- The secret scan is accepted only for the exact head and base commits that
  were scanned; every other covered job is bound to the tree.
- Protect the `ci-attestations` branch from deletion and force-push with a
  ruleset. An unsigned or altered record is refused regardless.
- Container-backed tests are skipped on a machine with no Docker engine. The
  record says whether there was one. Turbo still replays cached results, so
  `pnpm ci:attest run --fresh` is the way to run every task again.
- The pull request that adds a machine's key cannot be attested with that key:
  the key has to be on the base first.
- A merge-group run matches the record only when the queue builds the same
  tree. When it does not, the merge group runs in CI as before.
- If `main` moves after the local run, the trees no longer match and CI runs
  normally.

The full procedure and every limit are under "Signed local runs" in
[`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md).

`pnpm ci:attest publish` pushes from a scratch bare repository that borrows the checkout's
objects. Newer git (2.56 on GitHub's runners) moves a remote's tracking ref when a push names
that remote's URL, so a push by URL from the checkout itself would leave a new
`origin/ci-attestations` behind.

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

## Gate steps that failed for their own reasons

Four steps in `hobo-ci.yml` failed runs whose change was fine. Each has a test in
`scripts/test/merge-group-gate.test.ts` or `scripts/test/ci-deps-image-contract.test.ts` that runs the
step's own shell or loads what the step loads.

- **Cold dev loop without the worker image.** `dev-cold-loop-gate` picked the worker image or an
  `unshare --net` namespace by `runner.environment`. An overflow runner reports itself self-hosted and
  has no `hobo-ci-worker:local`, so `docker run` failed there. The step now asks Docker
  (`docker image inspect`) and uses the namespace whenever the image is absent, on any runner.
- **Main's S0 step window.** "S0 gate set" had 12 minutes on main and 20 in the merge group for the
  same commands on the same runners, so a commit the queue had passed could time out on main. Both
  are 20; on a push that equals the job's own limit.
- **The deps layer job loads its test without an install.** `ci-deps-image` runs
  `scripts/test/ci-deps-image-mount.test.ts` under `node --experimental-strip-types` with no
  `pnpm install`. The test imported `storage-admission.ts`, which imports `zod`, so the step ended in
  `ERR_MODULE_NOT_FOUND` before Docker ran. #1792 moved the node:fs job-directory operations to
  `packages/ci-gh-actions/src/isolated-worker/worker-storage-fs.ts` (node builtins only, re-exported
  by `storage-admission.ts`), which the test imports. The job's path filter did not list that file, so
  a PR that broke it skipped the job; it now does. The contract test walks the test's import graph,
  refuses a package import anywhere in it, requires every file in it to be in the path filter, and runs
  the test in a copy of those files with no `node_modules`.
- **DCO check.** The step listed `origin/<base>..HEAD` including merge commits (the PR merge ref and
  an update-branch merge are made by GitHub and carry no sign-off), and ran without
  `set -euo pipefail`, so a `git rev-list` that failed read as zero commits and passed. It now lists
  with `--no-merges` into a variable first, and greps a variable instead of a pipe (an early `grep -q`
  exit under `pipefail` would read as a missing sign-off).

Two script tests were wrong about the tree they guard:

- **Single-worker pins are read under `CI`.** `scripts/test/memory-env.test.ts` holds every Vitest
  config that pins one worker to `capVitestWorkers(1)`. `packages/hobo/vitest.config.ts` set
  `fileParallelism: false` (one worker, whatever `maxWorkers` says) next to
  `capVitestWorkers(process.env.CI ? 2 : undefined)`, which never took effect; it now says
  `capVitestWorkers(1)`. `packages/cli/vitest.config.ts` pins one worker in CI only, a form the test
  did not recognise while still listing that config as required, so it failed behind the first
  failure. The test now loads the configs with `CI` set and accepts both forms.
- **Git-fixture cases get 30 s.** Three cases in `scripts/test/stage-release-oci-app.test.ts` only
  spawn git against a fresh repository (no remote, no network), and such cases passed the 10 s default
  on a loaded runner.

## Running the scripts tests

`pnpm run test:scripts` runs every `scripts/test/*.test.ts` file and exits 0 on a healthy tree. It
is `scripts/run-tests.ts --category=scripts`: the Vitest-style files run in one Vitest process, then
the `node:test`-style files run under `node --import tsx --test`, and a failure in the first no longer
skips the second. A file is `node:test`-style when it imports `node:test` (`isNodeTestFile`), whatever
else it imports. The script used to hand the whole directory to `node --test`, which cannot load a
Vitest-style file, so it reported one failure per such file (25 of them) on any tree and nobody could
use it as a gate.

No workflow and no commit hook runs that lane. CI names single files instead: `hobo-ci.yml` runs a
few `node:test` files with `node --import tsx --test`, `release-hobo.yml` runs its Vitest-style files
with `pnpm exec vitest run`, and `scripts/relevant-check-policy.ts` selects four sets by changed path.
`scripts/test/script-test-runners.test.ts` holds each of those invocations to the runner
`test:scripts` gives the same file.

## Checks that went stale on main

No workflow and no commit hook runs the scripts tests as a whole, only the files they name, so these
checks failed on main before anyone saw them:

- **`actions:lint` on the real workflows.** `main_gate_finish`'s second checkout lacked
  `clean: false` (a box checkout at the default path must set it). The lint's tests only linted
  fixtures; `lint-actions-runner.test.ts` now also runs it on the repository. The lint also refuses a
  checkout that sets `clean: false` twice: two branches that each add the line to the same checkout
  merge without a git conflict into a duplicate YAML key, which GitHub cannot parse, so the workflow
  does not run at all.
- **Who waits for the deps image.** `ci-deps-image-contract.test.ts` sliced the workflow from
  `main-gate:` to `artifact-trust:` and required that text not to mention `ci-deps-image`. #1840 put
  `main_workspace_tests` inside that slice, and it waits for the image on purpose. The test now reads
  each job's `needs`: the required PR jobs and `main-gate` must not wait for the image even through
  another job; only `main_workspace_tests` does (the plan job runs beside it). Neither is gated on the
  deps job's result, so a failed deps job leaves the shards to install for themselves.
- **Deps layout recipe digest.** `DEPS_LAYOUT.recipeSha256` was last right at #1741. #1740, #1747,
  #1816 and #1792 edited `build-deps.sh` only: disk and inode headroom checks before a rebuild, an
  unused-image GC when headroom is short, and resolving the toolchain image when it is not in the
  Docker context. The Dockerfile and the bucket
  script are unchanged, so image contents and paths are too: the digest is updated and
  `DEPS_LAYOUT.version` stays 1, which leaves the deps key and every existing layer as they were.
- **Main shard planning vs Turbo affected.** The import-walk planner can list dependents Turbo
  would not schedule under `--affected`. `plan-main-workspace-shards.mts` and the shard CLI now
  intersect scoped plans with `turbo run test --affected --dry=json` at `TURBO_SCM_BASE` before
  balancing shards, so partition counts and weights match what each shard runs.
- **Repo-wide shard plan.** #1840 made `shardTestPlan` read the real `turbo run test --dry=json`
  graph for a repo-wide plan, while its test passes an in-memory tree of five fixture packages, so the
  real graph's packages were all "undiscovered". The graph is now a parameter (`TestGraph`, as
  `planCommands` already takes), defaulting to turbo. The test gives the fixture tree its own graph,
  and a second case partitions the real workspace list against the real graph.
- **Two memory-env checks after #1792 and #1833.** `scripts/test/memory-env.test.ts` read a
  hand-kept workflow list that still named `release-code.yml`, which #1772 deleted; it now checks
  every file in `.github/workflows/`. And #1833's live data lane exported `VITEST_MAX_WORKERS`, which
  Vitest lets override every config and the same test forbids in a workflow. The root vitest config
  and `packages/trails`'s now apply `HOBO_TEST_MAX_WORKERS` through `capVitestWorkers` themselves, so
  the lane no longer exports anything.

## The cli package's test cost

`packages/cli`'s suite spends nearly all of its time compiling TypeScript inside the tests (codegen
passes over real projects), not sleeping, spawning or waiting on a network. What keeps it down:

- **One module graph per worker.** `packages/cli/vitest.config.ts` keeps the root's `isolate: false`.
  Per-file isolation re-imported `src/index`, every `@hobo/*` dependency and the compiler for each of
  the 40-odd files. No file keeps state across files: env changes are restored in `finally`/`afterEach`
  (to the runner's value, not deleted), and every file that registers trainables or imports generated
  code in-process calls `resetTrainables()` after each test. The suite passes in file order and
  shuffled (`--sequence.shuffle --sequence.seed=<n>`).
- **Shared fixtures.** `test/support/built-starter.ts` builds each starter (`new` → `codegen` →
  `build`) once per worker and hands each caller a copy; a run-scoped `globalSetup`
  (`test/support/run-scratch.ts`) removes them. The cli config keeps the root's `globalSetup` list
  minus its wasmtime warm-up, which no cli test uses, so a setup the root adds later still runs.
- **Cheaper codegen passes, mostly from the declaration cache.** Codegen's compiler host takes the lib
  files and installed packages' `.d.ts` from a bounded cache (`src/codegen/declaration-cache.ts`, least
  recently used out past 2048 entries), so the two programs of a pass, and every later pass, reuse
  them; that is most of the win. Codegen also type-checks no declaration file, but it must still check
  tests and every other non-declaration file (`sourceDiagnostics`, so a missing global type a test
  file needs is still reported), which gives back much of that saving, and a project with
  `skipLibCheck` gains about nothing from it because the compiler skips declarations anyway. `typescript-app-build`'s fixture uses real
  `@types/node` (with `skipLibCheck`) only in the case that packages and runs the app.
- **Generated declarations checked on their own.** `codegen-app-compilation`'s three compile cases
  used to type-check all ~320 files of each program (TypeScript's libs, `@types/node`, the built
  `@hobo/core` and `@hobo/runtime` declarations), 2-5 s a case on a quiet machine and past the 10 s
  default with the pre-commit hook's turbo run sharing the CPUs. They now ask for the generated
  files' diagnostics only, from programs that share the dependencies' parsed source files, and a
  `beforeAll` pays the once-per-worker costs (the training stack's import, the first parse): 0.3-2 s
  a case and 1.5-6 s for the `beforeAll` under 8 busy loops on 4 CPUs, which timed out the first
  case (and at times all three, at 11-20 s) before.
- **Cheap refusals first, on authoritative inputs only.** `hobo build` refuses an explicit empty
  `services` list, or an explicit runtime for a Node app whose imprint's recorded inputs all still
  match, before its freshness gate regenerates the project. A project codegen has not generated (just
  scaffolded, or cloned without `.hobo/`) still gets the gate's drift answer
  (`test/build-before-codegen.test.ts`).
- **Workers.** CI runs one worker (`CI` set); elsewhere files spread across cores under the
  memory-derived `HOBO_TEST_MAX_WORKERS` cap. `typescript-project-codegen` is four files so it is not a
  single critical path. Case timeouts go through `test/support/slow.ts`, so `HOBO_TEST_TIMEOUT` can
  raise them on a loaded runner.
- **Lighter `hobo` processes.** `@hobo/cli` loads `ts-autocode-training` only when a codegen
  directive scan runs, and `@hobo/cli/argv` exports `CANONICAL_VERBS` and `parseArgv` without the CLI.
  The compiler still loads with `@hobo/cli`: `ts-autocode-grounding`'s only export imports it, and
  `codegen/text.ts` (used by the cloud loader) takes its digest helpers from there.

Measured on one CPU (`taskset -c 0`, `CI=1`, `HOBO_TEST_MAX_WORKERS=1`, `HOBO_TEST_TIMEOUT=600000`,
fresh `HOME`/`HOBO_HOME`/`TMPDIR`), back to back on a shared 4-CPU host: origin/main 550 s wall, 519 s
CPU (545 tests, load 16.5 → 12.5); after these changes 316 s wall, 303 s CPU (562 tests, load 12.7 →
8.4). Both runs fail the same 2 tests and one file, all because of this host: no `cue` v0.14.0 on
`PATH` (`codegen-schema-contract`), and a `/tmp/.hobo` marker above `os.tmpdir()` that `ci.test.ts` and
`shell.test.ts` read as a project root.

- **Worker image on PR deps rebuilds.** `ensure-ci-worker-image.mts` may pull `ghcr.io/.../hobo-ci-worker` on same-repo pull requests (not forks) so deps layer builds avoid a host `build.sh` when the runner lacks mise.
- **Release sparse cones.** `scripts/test/release-sparse-cone.test.ts` pins the exports in
  `scripts/lib/release-sparse-cone.mts` (for example `hoboReleaseSparseCones` and
  `filePathsRequiredByReleaseOciContractTests`) so release workflows do not drift from the cone list.

### Worker image downloads retry

The worker image's base layer downloads the GitHub Actions runner and Playwright's headless shell
with `curl`. A single connection reset from the CDN used to fail the whole image build, and with it
the CI deps layer job (seen on 2026-11-11: `curl: (35) Recv failure: Connection reset by peer`).
Both downloads now retry five times, on any error, three seconds apart; the pinned SHA-256 check
after each download is unchanged, so a retry can only produce the same verified file.
