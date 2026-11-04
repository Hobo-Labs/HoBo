# HoBo runner queue troubleshooting

GitHub shows **`queued`** (no steps, no runner name) when no self-hosted runner with the job’s label is online. HoBo CI jobs use **`runs-on: hobo`**. Those runners are **ephemeral JIT** registrations created by the HoBo CI relay when it admits a `workflow_job` webhook—not long-lived machines sitting in the org runner list.

## Symptom

- Workflow runs stay **`queued`** for minutes or hours (for example **HoBo CI Fabric** on a pull request).
- Manual **HoBo runner acceptance** with `jit_only=true` also queues if the relay is not dispatching.

A successful acceptance run on `main` or a feature branch only proves the relay worked **at that time**; org transfer or disabled providers can break dispatch without changing workflow YAML.

### Fork pull requests (untrusted code)

Release workflows (`release-hobo`, `release-code`, and related) **skip Docker socket work and secret-backed publish** when `github.event.pull_request.head.repo.fork` is true. A lightweight `fork-policy` job documents the skip; contract/static jobs may still run on `hobo` without pushing images or uploading build artifacts that carry workspace `dist/` trees. Require human approval for fork workflows in GitHub branch protection if your org policy demands it.

## Root cause checklist (operator)

Work through these on **Hobo-Labs/HoBo** after an org/repo transfer:

### 1. GitHub App + webhooks

- HoBo CI GitHub App must be **installed on the Hobo-Labs org** (or updated) with access to **Hobo-Labs/HoBo**.
- App webhooks must target the **ingress front door** HTTPS origin (`workflow_job`, `workflow_run`), not a relay URL baked into the App settings. The front door reads **`.hobo/ci.json` at the event’s config ref** and forwards signed webhooks to the selected environment’s `relayOrigin`.
- For **local dev and agents behind NAT**, set `jobAdmission: "pull"` on the `local` environment (or rely on default pull inference for loopback relays). Run `hobo ci enable` against `.hobo/ci.json`, then **`hobo ci serve --environment local --installation-id <id>`** (or `createJobPollAdmissionWorker` in custom hosts) — no public URL on your laptop.
- **Fork pull requests** never choose a contributor-controlled relay: routing uses the **base-branch** config ref and `selection.forkPullRequestEnvironment` when set.
- Webhook deliveries should be **200/202** in the GitHub App settings; repeated **401/503** means wrong secret or ingress/relay down.

See [`packages/ci-gh-actions/ONBOARDING.md`](../ci-gh-actions/ONBOARDING.md) and [`packages/ci-gh-actions/deploy/README.md`](../ci-gh-actions/deploy/README.md).

### 2. Repository connection (policy)

Runners tied to **`tyler-r-kendrick/HoBo` do not follow a transfer** to **Hobo-Labs/HoBo**. Re-run isolated repository onboarding:

- `connectIsolatedRepository` for **`Hobo-Labs/HoBo`** with required acknowledgments (`trustedRepositoryAcknowledged`, `publicRepositoryAcknowledged`, `acceptAllMatchingRepositoryJobs`).
- Provider offer enabled with current budget/observation evidence.

Without an admitted connection for the **current** repository full name, the relay ignores jobs even when webhooks arrive.

### 3. Isolated host (required for most CI here)

Admission sets **`isolatedRequired`** when the repo is **public**, on **`pull_request`**, or when the connection is isolated-only. That path needs an **isolated JIT host** on the relay—not the standalone Docker relay’s bridge-only mode.

**Paid path:** Vercel Sandbox (`provider: vercel`, `backend: sandbox`) on the hosted relay.

**Free path (budget exhausted):** add a zero-price **`hobo-box-worker`** offer with **`backend: isolated-container`** and `runsOn: hobo-isolated-worker` (see [`packages/ci/data-models/fixtures/valid/isolated-container-offer.json`](../ci/data-models/fixtures/valid/isolated-container-offer.json)). The legacy provider id `kubernetes` is still accepted for the same backend. Routing picks it when Sandbox reservation would exceed **`offer.budgetMicros`**. Launch requires the **isolated worker sidecar** on an operator-owned VM with Docker.

**Box mode (default): local SQLite + GitHub job poller.** The daemon keeps its own lease journal and webhook inbox in a SQLite file (`node:sqlite`, `@hobo/ci/sqlite`) under the user data dir — **`${XDG_DATA_HOME:-~/.local/share}/hobo-ci/worker.sqlite`**, override with **`HOBO_CI_WORKER_DB`**, never inside the checkout. With SQLite, admission defaults to **pull**: every **`HOBO_CI_JOB_POLL_MS`** (default 15000) it lists queued and in-progress workflow runs for each connection's repository with the App installation token, keeps jobs whose only label is **`hobo`** or **`hobo-trunk`**, and enqueues a synthetic `workflow_job` delivery into the local inbox. The tick then processes those deliveries exactly like signed webhooks, including the REST re-check of run and job, and launches containers. No Vercel relay, webhook ingress, or shared database is needed. The poller pauses on GitHub rate limits (429, 403 with `x-ratelimit-remaining: 0`, or fewer than 300 calls left) until the reset time. To stay well above that floor it re-reads every list with `If-None-Match` and the last ETag (a 304 does not count against the installation's limit), rounds the completed-runs lookback down to 10 minutes so that URL holds still, and reads a completed run attempt's jobs only until it has seen all of them completed: a re-run is a new attempt and is read again. An idle poll then costs no rate limit; before, every poll re-read the jobs of each run completed in the last two hours (any workflow, up to 50). Because GitHub's status-filtered list has missed a queued run for over 16 minutes, each poll also reads the newest 50 runs with no status filter (same ETag rule) and unions them with the filtered lists. A refused GitHub read logs `hobo_ci_isolated_worker_github_read_failed` (path and status). `hobo_ci_isolated_worker_jobs_polled` is logged when a poll accepts or refuses a job, fails a read or pauses, and when its `waiting` queued `hobo` jobs (`run/job:result`, not newly accepted) change, then once a minute while they keep waiting. A duplicate queued poll delivery is checked against local pending demand and active leases; uncovered jobs are re-admitted through the relay at most once per minute per delivery id.

```sh
export HOBO_CI_CONFIG=/etc/hobo-ci/config.json   # or HOBO_CI_CONFIG_JSON; offers + connections, no secrets
export HOBO_CI_GITHUB_APP_ID=…
export HOBO_CI_GITHUB_APP_KEY_FILE=/etc/hobo-ci/app.pem
export HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID=box     # = offer.providerAccountId
node --import tsx packages/ci-gh-actions/scripts/isolated-worker-daemon.mts
```

The daemon imports `@hobo/ci-gh-actions` and `@hobo/ci` from their built `dist`, so the start script first runs `pnpm exec turbo run build --filter=@hobo/ci-gh-actions` (a cache hit on a current tree, about 0.3 s) and refuses to start when that fails, logging `hobo_ci_isolated_worker_start_failed`. Before this, a checkout pulled past a new export started the daemon against the old `dist` and it crashed on a missing export (`createJobDurations` after #1663). Set `HOBO_CI_WORKER_BUILD=0` to skip the build when you build separately; a stale `dist` is then still reported with the rebuild command instead of a bare `SyntaxError`.

On start the daemon applies the config to the journal when it changed (a change refused because an active lease pins the provider identity keeps the stored policy and logs `hobo_ci_isolated_worker_configuration_kept`), and logs one `hobo_ci_isolated_worker_offer` line per offer with `launchable`, `enabled`, `concurrency`, `validUntil`, and `expired`. An expired `validUntil`, or one closer than `maxRuntimeMinutes + startupMinutes`, makes routing skip the offer.

**Shared relay mode (opt-in): Postgres + webhooks.** A worker that serves a hosted relay's partition sets **`HOBO_CI_STORE=postgres`**; the URL is read from the env var named by **`HOBO_CI_STORE_URL_ENV`** (default `DATABASE_URL`) and admission defaults to **push** (the relay ingests signed webhooks into the shared inbox):

```sh
export HOBO_CI_STORE=postgres
export DATABASE_URL=…            # same Postgres as the hosted relay
export HOBO_CI_PUBLIC_URL=https://hobo-ci.vercel.app
export HOBO_CI_WEBHOOK_SECRET=…
# plus HOBO_CI_CONFIG, App id/key and HOBO_CI_WORKER_PROVIDER_ACCOUNT_ID as above
node --import tsx packages/ci-gh-actions/scripts/isolated-worker-daemon.mts
```

`HOBO_CI_JOB_ADMISSION=pull|push` overrides either default. `hobo ci serve --with-worker` reads the same choice from the CI project config: `"store": { "kind": "sqlite" }` (the default, at `<HOBO_HOME>/ci/serve/worker.sqlite`) or `"store": { "kind": "postgres", "urlEnv": "DATABASE_URL" }`. The config names an env var and never holds a connection string. The same contract suite (`packages/ci-gh-actions/test/ci-store-contract.test.ts`) runs against both stores.

Each job runs in a **fresh Docker container** with the official Actions runner JIT (`labels: [hobo]` or `labels: [hobo-trunk]`, matching the job). The container image is **hermetic**: OS + system packages + pinned Actions runner bundle in a digest-pinned base, then **one OCI layer per tool** from repo-root `mise.toml` / `mise.lock` via **`mise --locked oci build`** (experimental). Healthy jobs do not install Node, pnpm, cue, turbo, gitleaks, or shellcheck at runtime. As a compatibility path for an older image, preflight discovers missing checkout tools and installs only those with `mise install --locked`, logs the names and elapsed time, then reruns the contract. It resolves each installed binary with `mise which`, verifies that absolute executable, prepends its bin directory to the current process `PATH`, and appends it to `$GITHUB_PATH` on GitHub Actions so later steps see it.

### Rebuild the runner image (box worker)

Run on a **native-arch Linux** host (arm64 box builds arm64 only; amd64 builds amd64 — no cross-compile). Requires **Docker** and pinned **mise** (`packages/ci-gh-actions/deploy/ci-runner/mise-version.txt`). Set **`MISE_EXPERIMENTAL=1`** only for the build (the build script exports it).

```sh
# From repo root — exact command Tyler asked for:
bash packages/ci-gh-actions/deploy/ci-runner/build.sh
```

That script:

1. Checks that Docker Hub serves the pinned **`debian:bookworm-slim@sha256:…`** digest (`scripts/ci-runner-verify-base-digest.mts`, anonymous registry API; `docker manifest inspect` from the image's Debian `docker.io` CLI rejects that OCI index) and that `skopeo` is on `PATH` or the engine loads OCI layouts (API ≥ 1.44), then `docker build` with context **`packages/ci-gh-actions/deploy/ci-runner/`** (not repo root) → `hobo-ci-runner-base:local`.
2. Push the base to the local **`registry:2`** container **`hobo-ci-registry`** (recreated for each build with ephemeral tmpfs storage, published on a free `127.0.0.1` port so it cannot collide with anything already on 5000) so `mise oci build --from` does not pull from Docker Hub. The daemon pushes over the published loopback port; inside a job container the script reads the registry at its bridge address. The registry, its transient tags, the OCI layout and any temporary archive are removed after the load.
3. `mise install --locked` + **`mise --locked oci build`** — every configured tool layer from **`mise.lock`**; **`skopeo copy`** loads it as `hobo-ci-worker:<version>`. Without skopeo, `mise oci push --image-dir` puts the layout in the local registry and the daemon `docker pull`s it, because the classic image store's `docker load` reads only docker-save archives. The runner contract runs inside that candidate (inputs streamed in, no bind mount) before it is tagged `:local`.

Version tag: `node --no-warnings scripts/ci-runner-image-version.mts` (hash of `mise.lock`, `mise.toml`, base Dockerfile, `system-packages.txt`, and `build.sh` itself). When `hobo-ci-worker:<version>` is already on the host (a re-run, or main after the pull request that built the same inputs), `build.sh` skips the build: it runs the contract in that image and retags `:local`. On a local miss it next tries `ghcr.io/<owner>/<repo>/hobo-ci-worker:<version>` (lowercased `GITHUB_REPOSITORY`, default `Hobo-Labs/HoBo`), then runs that same contract before promotion. Only a registry miss, unavailable or failed login, or failed contract triggers the native build. The image and release workflows all call this script instead of treating an arbitrary existing `:local` as current. The monolithic fallback uses the same content tag and skip check. Every success prunes BuildKit to the hard cap and deletes unused worker tags other than the current and previous keys; `:local` and every tag of an image used by a running container are protected.

**When to rebuild:** any change to `mise.toml`, `mise.lock`, `packages/ci-gh-actions/deploy/ci-runner/**`, or runner contract scripts. HoBo CI Fabric job **`CI runner image (mise oci)`** rebuilds affected-only on `hobo` when those paths change (needs host Docker socket — worker daemon mounts `/var/run/docker.sock` by default; set `HOBO_CI_MOUNT_DOCKER_SOCKET=0` to disable). On push, the job-level condition checks every commit's added, modified and removed file lists and skips the job when none contains an image input; missing file lists and forced pushes fail open toward building. A skipped job satisfies `needs` immediately, so Main full gate does not wait for a no-op. Inside a job container `build.sh` reaches the registry by the `hobo-ci-registry` container's bridge address (`127.0.0.1` there is the container's own loopback) and loads the layout with `docker load` when the image has no `skopeo`. When the job runs, its Detect step diffs `HEAD~1..HEAD` on a depth-2 checkout (the previous main commit on push, the base on a pull request's merge commit) with `grep`. It is skipped on `merge_group`, so a queue entry never retags `hobo-ci-worker:local` from an unmerged group commit; a pull request that changes the image inputs does retag it, but only after the runner contract passes inside the candidate. GHCR publishing runs on main only. `PR impact gate` and `Main full gate` declare `needs: ci-runner-image` (with `!cancelled()`), so a run that changes the image inputs starts its gate on the image it just built.

**Host disk between jobs.** Each job's Actions work folder is `HOBO_CI_WORKER_WORK_ROOT/hobo-<lease-id>`, bind-mounted into its container. Lifecycle teardown deletes it on pass, failure, cancellation, crash or timeout; startup reaps leftovers only when their lease is inactive and container absent. `hobo_ci_work_dir_removed` logs bytes and entries. `/tmp` still lives in the `--rm` container. `ci-runner-preflight` also prunes untagged images over a day old and stopped `hobo.ci/isolated=1` containers over ten minutes old, then prints `docker system df`; unlabelled containers are never touched.

**Shared packages and daemon GC.** Every job mounts the host pnpm store read-write at `/pnpm-store` and installs with `npm_config_package_import_method=hardlink`. The store and work root must be on one filesystem; daemon startup refuses a cross-filesystem configuration. Only the daemon prunes the store, and only with no active job (the conservative install lease). At least every five minutes and on storage pressure it removes unused `hobo-ci-deps-fetch:*` intermediates, all but the two newest non-local `hobo-ci-deps:*` images, unused worker versions other than the current and previous keys, dangling images, and BuildKit entries beyond the hard 4 GB default cap regardless of age. Both `:local` tags and images used by running containers stay. The cold dev loop job installs only what its script imports (2.2 GB streamed into the offline container instead of 4.6 GB).

**GHCR (optional, public repos):** when `GHCR_TOKEN` is non-empty, the build logs in and can reuse or push `ghcr.io/<owner>/<repo>/hobo-ci-worker:<version>`. With no token, pull and push are skipped and no interactive login is attempted. A failed login also skips the pull and falls back to the native build.

**Deps layer:** `CI deps layer (pnpm)` builds `hobo-ci-deps:<toolchain>-<depsKey>` from the staged lockfile/manifests, verifies an offline up-to-date install, and only then promotes `hobo-ci-deps:local`. The key also covers the deps Dockerfile and build script. Fetch and install reuse the persistent host pnpm store through BuildKit's `hobo-pnpm-store` cache mount; the final image contains only the `node_modules` trees and `.git` skeleton. Every event first compares the computed key with the `hobo.ci.deps-key` label on `hobo-ci-deps:local`; an exact match skips resolution, promotion, build, and push after one inspect. A miss checks the exact keyed local tag, then GHCR, and skips the build on either hit. Every main push runs this fast check; schedule and dispatch also always run. These events can pull/publish the same tag under `ghcr.io/<owner>/<repo>/hobo-ci-deps`. A PR whose diff touches `deploy/ci-runner/deps/**` or the deps-key scripts reuses an existing keyed image or runs the build and contract with `--no-promote`; it never pushes. Other PRs make that job a no-op. Neither Main full gate nor PR impact gate depends on this job.

The worker selects the deps image only when the lease repository matches **`HOBO_CI_DEPS_REPOSITORY`** case-insensitively (default **`Hobo-Labs/HoBo`**), **`HOBO_CI_DEPS_IMAGE`** (default **`hobo-ci-deps:local`**) exists, and its `hobo.ci.toolchain` label equals the `hobo-ci-worker:<version>` tag on the current worker image. It exports **`HOBO_CI_DEPS_LAYER`** with the image's full deps-key label. Missing, unreadable, or mismatched images fall back to the worker image without failing the launch; an inspection failure is logged once per image. A pre-warmed container is reused only when image and deps key match the lease. Set **`HOBO_CI_DEPS_IMAGE=`** (empty) to force every job onto the plain worker image, or set `HOBO_CI_DEPS_REPOSITORY` to a non-HoBo name to disable selection for HoBo. Default-path box checkouts use `clean: false` so checkout does not remove prebuilt `node_modules`. Main full gate and PR impact gate skip install on an exact key match and verify the ts-autocode links; every miss installs. The daily scheduled Main full gate always installs as the correctness verifier, and other jobs retain their frozen install.

**Daemon-owned availability:** the worker no longer waits for a workflow event to produce the layer. On startup and every **`HOBO_CI_DEPS_POLL_MS`** (default **300000**, five minutes), it checks the head of its default-branch checkout. **`HOBO_CI_DEPS_ROOT`** overrides the default repository root derived from the daemon module, so the service manager's working directory does not matter. A changed head resolves the same toolchain as `build-deps.sh`: the checkout-computed worker tag when present, otherwise the versioned tag on `hobo-ci-worker:local`. It recomputes the key with that explicit toolchain; an unchanged key does no further Docker work. For a missing key it tries `docker pull ghcr.io/<owner>/<repo>/hobo-ci-deps:<key>`, then falls back to one background `build-deps.sh --no-promote` at a time. Success tags the candidate `hobo-ci-deps:local` and runs the daemon's shared keep-2 selector through `scripts/ci-runner-image-gc.mts`. Builds never block admission or consume a worker slot; they run under `nice`/`ionice` with **`HOBO_CI_DEPS_BUILD_MEMORY_MB`** (default **4096**) passed as Docker's `--memory` limit. `hobo_ci_deps_image_ensure_started` logs the key before work and `hobo_ci_deps_image_ensure` logs `{key, action: hit|pull|build, ms}` after success. A failed key read, pull/build, tag, or GC logs `hobo_ci_deps_image_ensure_failed` and retries with exponential backoff from one minute to 15 minutes, fail-open. Jobs continue using the ordinary worker image until the local tag is ready.

**Preflight:** every `runs-on: hobo` job starts with `.github/actions/ci-runner-preflight` (`scripts/ci-runner-preflight.mts`). Failures mean the worker image is stale — rerun `build.sh` on the box.

**CI fabric contract guard** (HoBo CI Fabric `ci-guard` job): `node --import tsx --test scripts/test/ci-runner-image-contract.test.ts` after install. The file uses `node:test`, like its sibling script contract suites; Vitest cannot discover those suites.

**Fallback:** if a tool cannot be packaged with `mise oci` (asdf backend, broken vfox hooks), use `Dockerfile.monolithic` and document why — see `packages/ci-gh-actions/deploy/ci-runner/README.md`.

```sh
export HOBO_CI_WORKER_IMAGE=hobo-ci-worker:local
node --import tsx packages/ci-gh-actions/scripts/isolated-worker-daemon.mts
```

**Graceful stop:** send **`SIGTERM`** (systemd/Kubernetes preStop). The daemon stops polling for new lease work, **waits for any in-flight poll tick to finish**, then waits until no lease on this worker's offers is launching, registering or running a job, reconciling before each check without admitting new work (default **`HOBO_CI_WORKER_DRAIN_TIMEOUT_MS=1800000`**, 30 minutes; the supervisor's stop timeout, such as systemd `TimeoutStopSec`, must be longer). A repeated `SIGTERM` does not cut the drain short. It then closes the store (SQLite file or Postgres pool) and exits **`0`** when drained or **`1`** on timeout.

Job containers run as **`1000:1000`**; when the host Docker socket is mounted, **`createCliDockerDriver`** adds **`--group-add`** for the socket’s gid so in-container **`docker`** can talk to the engine (see **`cli-docker-driver.ts`**).

Job containers are created with **`--init`**. Their PID 1 is `sleep infinity`, which ignores `SIGTERM`, so without an init every **`docker stop -t 30`** ran its full 30 s while the finished lease still held its slot — and the poll tick reconciles leases serially, so that stop also delayed the next launch. Across 43 post-parallel runs the gap between a slot freeing and the next queued job starting had a median of **48 s** (p90 82 s). The change takes effect only after the box daemon is redeployed.

Force-stop settlement on the box worker **re-queues the reserved job** when GitHub still shows it **`queued`** (for example the ephemeral runner picked up a different workflow job first); the store dedupes pending demand.

**Runner exit frees the slot.** The JIT runner takes one job and exits, but the container (`sleep infinity`) keeps running. `startRunner` therefore writes **`/tmp/hobo-ci-runner-exited`** once `run.sh` returns, whatever its status. Each tick, reconcile checks for the marker with `docker exec <id> test -e` (30 s timeout; a failed check is retried, never treated as an exit) and stops and settles the lease. A slot no longer waits for the job poll (`HOBO_CI_JOB_POLL_MS`) to report the job completed, and a runner that died without taking a job no longer holds its slot until the lease's maximum runtime. If assignment attribution or the marker is unavailable on a **trunk-labelled** lease, reconcile also reads the original job when `actualJobId` is zero: a completed job whose `runner_name` exactly matches the lease authorizes the same stop on that tick. General leases retain the exact-assignment requirement and incur no additional reads. A swapped lease still checks only its actual job, so the fallback cannot stop a different job using the runner. Settlement requeues the reserved job when GitHub still shows it `queued`. A job can create the marker itself, but that only ends its own container early.

**Memory admission:** every job has a class-sized request used as its Docker `--memory` and `--memory-swap` limit. Active + reserved requests, the standard-sized warm container, and the heavy trunk reservation must fit the budget; otherwise the job stays queued. Exact GitHub job names select `light` (3072 MiB) for guard/lint/contract jobs, `standard` (4096 MiB, the unlisted default), or `heavy` (6144 MiB) for turbo build/test and image lanes. On the 15989 MiB box, the default budget is `15989 - 2048 = 13941 MiB`: heavy + standard + light = 13312 MiB fits three slots, while two heavy jobs leave only 1653 MiB and three heavy jobs cannot fit. See [finding 24](../../docs/ci/performance.md#finding-24-slot-only-admission-let-the-host-oom-killer-choose-a-victim).

| Daemon variable | Default | Meaning |
|---|---|---|
| `HOBO_CI_WORKER_MEMORY_BUDGET_MB` | host/cgroup memory minus reserve | Total admitted memory; an explicit value may not exceed that derived ceiling |
| `HOBO_CI_WORKER_MEMORY_RESERVE_MB` | `2048`, minimum `2048` | Docker daemon, worker and page-cache headroom used by the budget ceiling |
| `HOBO_CI_WORKER_MEMORY_CLASS_LIGHT_MB` | `3072` | Light class hard limit |
| `HOBO_CI_WORKER_MEMORY_CLASS_STANDARD_MB` | `4096` | Standard class and warm-container hard limit |
| `HOBO_CI_WORKER_MEMORY_CLASS_HEAVY_MB` | `HOBO_CI_WORKER_MEMORY_MB` or `6144` | Heavy class and trunk reservation |
| `HOBO_CI_WORKER_MEMORY_MB` | unset | Backward-compatible heavy-class override; startup checks still apply |
| `HOBO_CI_WORKER_MEMORY_HOL_MS` | `60000` | Backfill window before a non-fitting head job blocks smaller jobs in the same rank |
| `HOBO_CI_JOB_MEMORY_MB` | admitted class value | Per-container value exported to the runner; fallback when its cgroup limit cannot be read |
| `HOBO_CI_WORKER_MERGE_GROUP_LEASES` | `1` | Maximum active reserved/running merge-group leases; must be a positive integer |
| `HOBO_CI_WORKER_WORK_ROOT` | `${XDG_STATE_HOME:-~/.local/state}/hobo-ci/work` | Host root for per-job work mounts, teardown and byte/inode pressure checks; same filesystem as pnpm store |
| `HOBO_CI_PNPM_STORE_DIR` | `~/.cache/hobo-ci/pnpm-store` | Shared content-addressed store mounted at `/pnpm-store`; empty disables it |
| `HOBO_CI_WORKER_GC_MS` | `300000` | Scheduled image, builder, store and dead-workdir GC interval; minimum 60000, capped at 300000 |
| `HOBO_CI_WORKER_BUILDER_CACHE_CAP` | `4GB` | Hard BuildKit cap independent of age; deprecated alias `HOBO_CI_WORKER_BUILDER_KEEP_STORAGE` |

Startup fails unless every general class fits outside the trunk reservation and the heavy trunk class fits the full budget. Wait/admit decisions log `hobo_ci_memory_admission_wait` / `hobo_ci_memory_admitted`; Docker-confirmed exit-137 OOM kills log `hobo_ci_container_oom` with the class.

The daemon computes each job's heap from its admitted memory class and injects `NODE_OPTIONS=--max-old-space-size=<heap>` at container creation, so every Node process inherits it and no workflow-level value overrides it. `ci-runner-preflight` also runs `scripts/ci/memory-env.mts` before install. It reads the job cgroup limit and writes the non-blocked **`HOBO_NODE_OPTIONS`** (never `NODE_OPTIONS` through `$GITHUB_ENV`), **`HOBO_TURBO_CONCURRENCY=1`**, and the repo-owned `HOBO_TEST_MAX_WORKERS`. After a 768 MiB native/non-heap allowance, workers are `max(1, min(cpuCount, floor((limit - 768) / 1280) - 1))`; each Node process receives `min(3072, floor((limit - 768) / (workers + 1)))` MiB of heap. Thus `(workers + 1) × heap + 768 <= limit`: the turbo/Vitest parent and every worker fit the same container budget instead of each receiving an independent full-size heap.

| Class | Container limit | Node heap per process | Max Vitest workers |
|---|---:|---:|---:|
| `light` | 3072 MiB | 1152 MiB | 1 |
| `standard` | 4096 MiB | 1664 MiB | 1 |
| `heavy` | 6144 MiB | 1344 MiB | 3 |

Configs resolve the smaller of their own cap and this value; CI does not export `VITEST_MAX_WORKERS`, which Vitest would apply after config resolution and after `fileParallelism: false`, overriding correctness-critical single-worker pins. Workflows retain a conservative 1-worker/1024 MiB fallback if preflight is skipped. The Main full gate's `check:all` step also sets **`HOBO_RELEVANT_CHECK_CONCURRENCY=1`**. If `test:unit` ends with exit 1 and no Vitest summary, look for `run-tests: vitest was killed by <SIGNAL>` in the log.

**Disk and inode admission:** before each reservation, the daemon samples bytes and inodes on Docker's data root and the work root. Above 85% for either resource it runs the full scheduled GC described above, then samples again. Above 95% after pruning, the job waits and `hobo_ci_inode_pressure` is logged once per episode. A live job's directory is never deleted. See [finding 25](../../docs/ci/performance.md#finding-25-inode-exhaustion-made-pr-installs-fail-with-enospc).

Legacy path `packages/ci-gh-actions/deploy/worker/Dockerfile` is deprecated; use **`build.sh`** above.

This preserves PR isolation without Sandbox spend.

From [`packages/ci-gh-actions/ONBOARDING.md`](../ci-gh-actions/ONBOARDING.md):

> The Vercel composition enables the isolated host only when Sandbox is explicitly configured. Without that configuration, isolated onboarding and dispatch fail closed.

PR CI (**HoBo CI Fabric** on `pull_request`) is always in this bucket for a public repo.

### 4. JIT label contract

- Workflows must use exactly one runner label: **`hobo`**, or **`hobo-trunk`** for the jobs of `push`, `workflow_dispatch` and `merge_group` runs. The relay rejects jobs with extra runner labels. Each JIT runner registers with the one label its lease's job asked for (`packages/ci-gh-actions/src/runner-labels.ts`).
- Trunk-capable jobs in every enabled box workflow, including `hobo-ci.yml`, `release-hobo.yml` and `release-code.yml`, ask for **`hobo-trunk` by default** through `${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('["push","workflow_dispatch","merge_group"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}`. This includes **PR impact gate** on `merge_group`; its `pull_request` runs use `hobo`. Setting repository variable **`HOBO_CI_TRUNK_RUNNER=false`** is the kill switch that returns trunk runs to `hobo`; pull-request-only jobs always use `hobo`. PR-only jobs, including Secret scan (trunk events scan history inside Main full gate), request plain `hobo`.
- `scripts/lint-actions.ts` allows only that expression and `runs-on: hobo`. Its **`trunk-label-routing`** rule also fails a push/merge-group/dispatch-capable job on plain `hobo` and a PR-only job on the expression. Other repositories served by the same box must use the expression for their push, merge-group, and manual-dispatch jobs too: event rank alone does not reserve trunk capacity, and a shared-label runner can be assigned to an older PR job.
- A trunk-event job still requesting `hobo` logs **`hobo_ci_trunk_job_on_shared_label`** once per job, with `repository`, `workflow`, `runId`, and `jobId`. Treat that event as a workflow misconfiguration; it remains capped with shared-label demand.
- **Rollout:** the box daemon must run a main at or after **#1678**, which serves `hobo-trunk`. The default trunk slot and label-based capacity fixes also need a daemon redeploy. Until both are deployed, set **`HOBO_CI_TRUNK_RUNNER=false`** on an older box; otherwise trunk jobs would wait for a runner nobody launches.
- Registered JIT runners must match **`hobo-{uuid}`** name pattern (see acceptance workflow).

### 5. Budget and concurrency

Relay returns **`waiting-for-budget-or-capacity`** when account/provider budget or concurrency is exhausted. Check relay logs and policy API; queued GitHub jobs will not start until a reservation succeeds.

Capacity goes out in admission order, not arrival order: `merge_group`, `push` and `workflow_dispatch` jobs first, then pull-request jobs, then `schedule`, and within each the run that started first. A pending job whose single label is `hobo-trunk` keeps trunk rank even if its run lookup fails; a `hobo` job takes its rank from the run event. The poller primes each run's event and start time from the run lists it already reads, without another GitHub request; a later lookup failure retains that rank. Within a run, the box daemon admits the job expected to take longest first: the median of that job name's last five successful durations, which the job poller learns from the jobs lists it already reads. A job with no history counts as 0, and the job id breaks any remaining tie. The history lives in memory and is re-learned from the two-hour completed-runs lookback after a restart. Reservations and reserved-lease launches both use this order. Deferred reservation applies it to the poller's accepted batch regardless of delivery order, and a swapped job re-enters it with the labels read from GitHub.

**`HOBO_CI_WORKER_MERGE_GROUP_LEASES`** defaults to **1** and must be a positive integer. The daemon counts active reserved and running leases using the admission cache's run event; excess merge-group jobs stay queued without a runner and log **`hobo_ci_merge_group_cap_wait`** once per job. They are admitted in the order above when a lease ends, and a waiting merge group never blocks a push job from taking trunk capacity. Set the repository merge queue's **maximum pull requests to build** to **1** on this 16 GiB box too: that is a repository setting, not code, and limits how many groups GitHub builds in parallel before they reach the worker.

**`HOBO_CI_WORKER_TRUNK_SLOTS`** defaults to **1** when **`HOBO_CI_WORKER_SLOTS >= 2`**, otherwise **0** (explicit values remain validated from 0 through `HOBO_CI_WORKER_SLOTS - 1`, with the offer's `concurrency` equal to `HOBO_CI_WORKER_SLOTS`). It sets aside slots whose runners GitHub can assign only to **`hobo-trunk`** jobs. Shared-label runs, including push jobs mistakenly still on `hobo`, hold at most `HOBO_CI_WORKER_SLOTS - HOBO_CI_WORKER_TRUNK_SLOTS` active leases. Strict mode is the default: **`HOBO_CI_WORKER_TRUNK_LEND=1`** lends spare trunk capacity to shared-label jobs while no trunk-label job waits. Once one is pending without a lease, the cap applies. In either mode, a trunk-label job that cannot reserve cancels the newest general lease still in `reserved` with no container, runner, or host run, requeues its job, and retries in the same pass. This also lets trunk demand beyond the reserved slot count reclaim general reservations. Leases with a launched host or running job are never cancelled. An idle pre-warmed container has no lease and does not count against the slot budget; launch renames and reuses it. If GitHub gives a trunk runner to another job, the original queued job becomes pending again and takes the next free slot rather than waiting for the borrowed runner to finish. This requeue reads the still-queued job directly, independently of the poller's duplicate delivery marker, and launches the replacement with the job's own label. The swapped lease continues the other job untouched, while replacement detection permits only one unswapped active lease for the original job.

The target is for a queued main or merge-group job to be admitted on the **next daemon tick after a slot frees**, normally seconds after the poller discovers it. A second trunk job may take a free general slot immediately, or reclaim an unlaunched PR reservation, ahead of all queued PR work. This trunk-to-general borrowing does not depend on `HOBO_CI_WORKER_TRUNK_LEND`; that setting controls only the opposite direction. **Running PR jobs are never preempted**, because killing one would lose its work and fail its PR check. Label separation keeps GitHub from handing a trunk runner to an older PR job ([finding 13](../../docs/ci/performance.md#finding-13-github-gave-the-runner-launched-for-main-to-an-older-pr-job)).

A trunk job that cannot reserve for more than **10 s** logs one **`hobo_ci_trunk_wait`** JSON event per wait episode with **`reason: "lease-capacity"`**, **`waitedMs`**, **`repository`**, **`runId`**, and **`jobId`**. Its wait clock survives across relay ticks and resets after reservation or when the job leaves the queue. Use this to separate lease-capacity starvation from job discovery and container startup. The 2026-11-04 incident and completed-original-job reconciliation fallback are recorded in [finding 24](../../docs/ci/performance.md#finding-24-a-completed-merge-group-lease-still-occupied-the-trunk-slot).

The daemon change and its `HOBO_CI_WORKER_TRUNK_*` settings take effect only after a box redeploy. See [finding 9](../../docs/ci/performance.md#finding-9-a-freed-slot-went-to-whichever-job-the-worker-saw-first), [finding 11](../../docs/ci/performance.md#finding-11-a-runs-long-pole-was-admitted-last), [finding 15](../../docs/ci/performance.md#finding-15-trunk-jobs-starved-for-16-minutes), and [finding 23](../../docs/ci/performance.md#finding-23-the-trunk-slot-went-to-a-runner-a-pr-job-could-take).

### 6. Merge queue (landing, not pickup)

**Merge queue** requires branch protection on `main` with merge queue enabled and the required HoBo CI checks. **Main full gate** is not one of them and does not run on `merge_group` (it runs on the push to `main`), so a queue entry holds no slot for it. Instead, the required **PR impact gate** runs on `merge_group` and executes Main full gate's affected S0 and dependent workspace-test lanes against the merge group's base SHA. That gates **merge** after jobs complete; it does not cause **`queued`** by itself. The required **CI fabric contract guard** runs only on `pull_request`; its two contract steps run inside **Main full gate** on push, schedule and dispatch, and inside **PR impact gate** on `merge_group`.

Set repository variables **`TURBO_TEAM`** and secret **`TURBO_TOKEN`** for remote Turbo cache (fork PRs use read-only remote mode in workflow).

Without them, a box job's Turbo local cache is **`hobo-turbo-cache`** inside the host-mounted pnpm store (`TURBO_CACHE_DIR`, set by `.github/actions/turbo-cache` when `HOBO_CI_PNPM_STORE_MOUNTED=1`). Same-repository PR, merge-group, push, dispatch and schedule jobs share it, so a main push replays the test tasks its PR already passed on the same tree. A PR whose head repository is not this one (a fork, or a deleted fork) never gets `TURBO_CACHE_DIR` and keeps the per-ref `actions/cache` fallback. `scripts/ci/turbo-cache-prune.mts` drops entries unused for 7 days (`HOBO_TURBO_CACHE_KEEP_DAYS`). Runners without the mount keep the per-ref `actions/cache` fallback. See [finding 12](../../docs/ci/performance.md#finding-12-main-re-ran-the-tests-its-own-pr-had-just-passed).

## Verify end-to-end

1. **`curl --fail https://<relay-origin>/readyz`** — relay healthy (local: `hobo ci serve` then `curl --fail http://127.0.0.1:8787/readyz` when using default local `relayOrigin`).
2. **GitHub → App → Recent deliveries** — `workflow_job` **queued** events succeed when you re-run a stuck workflow.
3. **Manual JIT smoke** (does not need checkout):

   ```sh
   gh workflow run hobo-ci-acceptance.yml --repo Hobo-Labs/HoBo -f jit_only=true
   ```

   Run should leave **`queued`** within ~1–2 minutes if dispatch works; watch runner name **`hobo-…`** in job details.

4. **Live relay acceptance** (admin token, local clone):

   ```sh
   node --import tsx packages/ci-gh-actions/scripts/acceptance.ts --live-verify --repository Hobo-Labs/HoBo
   ```

## What repo CI cannot fix

These require org admin / platform operator action, not a workflow edit:

- Installing or re-pointing the GitHub App after org transfer.
- Relay deploy, secrets, Postgres/SQLite partition, Vercel Sandbox credentials.
- Re-onboarding **Hobo-Labs/HoBo** in relay policy.
- Org/repo **Actions** permissions for fork PRs if you expect fork contributions to run CI.

Workflow YAML in this repository requests exactly **`hobo`** or **`hobo-trunk`**; a permanently **`queued`** run means **no matching JIT runner registered**, almost always because the relay did not admit or launch the job.

## Quick probe (repo script)

```sh
node --import tsx scripts/ci/verify-relay-dispatch.mts
# optional: --relay https://hobo-ci.vercel.app --repository Hobo-Labs/HoBo
```

Exit **0** only when **`GET /readyz`** returns JSON **`{"ready":true}`** (HTTP 200). As of the last operator check, **`https://hobo-ci.vercel.app/healthz`** was **`{"ok":true}`** while **`/readyz`** returned **`{"ready":false}`** — isolated JIT dispatch stays off until readiness clears (Sandbox env, worker health, database — see [`packages/ci-vercel/README.md`](../ci-vercel/README.md)).
