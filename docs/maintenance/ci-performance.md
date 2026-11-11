# CI performance notes

How the self-hosted HoBo CI keeps PR gates fast, and where to look when it slows down.

- **Parallel isolated containers.** The box worker (`packages/ci-gh-actions/scripts/isolated-worker-daemon.mts`)
  runs up to `HOBO_CI_WORKER_SLOTS` jobs at once, subject to both slot and memory admission. Exact job names
  select light/standard/heavy hard container limits (3072/4096/6144 MiB); active, reserved and warm requests
  must sum within host/cgroup memory minus at least 2048 MiB reserve. On the 15989 MiB box that budget is
  13941 MiB, so three mixed classes can fit but three heavy jobs cannot. Job preflight derives the Node heap,
  serial turbo and `HOBO_TEST_MAX_WORKERS` from the admitted container limit; CI never exports
  `VITEST_MAX_WORKERS`, preserving single-worker config pins. Byte or inode usage above 85% triggers safe
  pruning before admission, and usage above 95% after pruning leaves the job queued.
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
`packages/core/src/_generated/actor_host_port_pb.ts` now plans 13 whole suites and 14 subsets and
skips 106 dependents (10 and 13 of them without the wider bystander check above). The edge is dropped
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
real-tree pins count packages, so a change that adds or removes one re-pins them: #1803 added three
packages a generated `@hobo/core` leaf does not reach and left that plan's skipped count at 103, where
the planner gives 106.

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
