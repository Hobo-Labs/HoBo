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

**Box mode (default): local SQLite + GitHub job poller.** The daemon keeps its own lease journal and webhook inbox in a SQLite file (`node:sqlite`, `@hobo/ci/sqlite`) under the user data dir — **`${XDG_DATA_HOME:-~/.local/share}/hobo-ci/worker.sqlite`**, override with **`HOBO_CI_WORKER_DB`**, never inside the checkout. With SQLite, admission defaults to **pull**: every **`HOBO_CI_JOB_POLL_MS`** (default 15000) it lists queued and in-progress workflow runs for each connection's repository with the App installation token, keeps jobs whose only label is **`hobo`**, and enqueues a synthetic `workflow_job` delivery into the local inbox. The tick then processes those deliveries exactly like signed webhooks, including the REST re-check of run and job, and launches containers. No Vercel relay, webhook ingress, or shared database is needed. The poller pauses on GitHub rate limits (429, 403 with `x-ratelimit-remaining: 0`, or fewer than 300 calls left) until the reset time. To stay well above that floor it re-reads every list with `If-None-Match` and the last ETag (a 304 does not count against the installation's limit), rounds the completed-runs lookback down to 10 minutes so that URL holds still, and reads a completed run attempt's jobs only until it has seen all of them completed: a re-run is a new attempt and is read again. An idle poll then costs no rate limit; before, every poll re-read the jobs of each run completed in the last two hours (any workflow, up to 50). Because GitHub's status-filtered list has missed a queued run for over 16 minutes, each poll also reads the newest 50 runs with no status filter (same ETag rule) and unions them with the filtered lists. A refused GitHub read logs `hobo_ci_isolated_worker_github_read_failed` (path and status). `hobo_ci_isolated_worker_jobs_polled` is logged when a poll accepts or refuses a job, fails a read or pauses, and when its `waiting` queued `hobo` jobs (`run/job:result`, not newly accepted) change, then once a minute while they keep waiting.

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

Each job runs in a **fresh Docker container** with the official Actions runner JIT (`labels: [hobo]`). The container image is **hermetic**: OS + system packages + pinned Actions runner bundle in a digest-pinned base, then **one OCI layer per tool** from repo-root `mise.toml` / `mise.lock` via **`mise oci build`** (experimental). Workflows do not install Node, pnpm, cue, turbo, or gitleaks at job runtime.

### Rebuild the runner image (box worker)

Run on a **native-arch Linux** host (arm64 box builds arm64 only; amd64 builds amd64 — no cross-compile). Requires **Docker** and pinned **mise** (`packages/ci-gh-actions/deploy/ci-runner/mise-version.txt`). Set **`MISE_EXPERIMENTAL=1`** only for the build (the build script exports it).

```sh
# From repo root — exact command Tyler asked for:
bash packages/ci-gh-actions/deploy/ci-runner/build.sh
```

That script:

1. Checks that Docker Hub serves the pinned **`debian:bookworm-slim@sha256:…`** digest (`scripts/ci-runner-verify-base-digest.mts`, anonymous registry API; `docker manifest inspect` from the image's Debian `docker.io` CLI rejects that OCI index) and that `skopeo` is on `PATH` or the engine loads OCI layouts (API ≥ 1.44), then `docker build` with context **`packages/ci-gh-actions/deploy/ci-runner/`** (not repo root) → `hobo-ci-runner-base:local`.
2. Push the base to the local **`registry:2`** container **`hobo-ci-registry`** (started if needed, published on a free `127.0.0.1` port so it cannot collide with anything already on 5000) so `mise oci build --from` does not pull from Docker Hub. The daemon pushes over the published loopback port; inside a job container the script reads the registry at its bridge address.
3. `mise install` + **`mise oci build`** — tool layers from **`mise.lock`**; **`skopeo copy`** loads it as `hobo-ci-worker:<version>`. Without skopeo, `mise oci push --image-dir` puts the layout in the local registry and the daemon `docker pull`s it, because the classic image store's `docker load` reads only docker-save archives. The runner contract runs inside that candidate (inputs streamed in, no bind mount) before it is tagged `:local`.

Version tag: `node --no-warnings scripts/ci-runner-image-version.mts` (hash of `mise.lock`, `mise.toml`, base Dockerfile, `system-packages.txt`, and `build.sh` itself). When `hobo-ci-worker:<version>` is already on the host (a re-run, or main after the pull request that built the same inputs), `build.sh` skips the build: it runs the contract in that image and retags `:local`.

**When to rebuild:** any change to `mise.toml`, `mise.lock`, `packages/ci-gh-actions/deploy/ci-runner/**`, or runner contract scripts. HoBo CI Fabric job **`CI runner image (mise oci)`** rebuilds affected-only on `hobo` when those paths change (needs host Docker socket — worker daemon mounts `/var/run/docker.sock` by default; set `HOBO_CI_MOUNT_DOCKER_SOCKET=0` to disable). Inside a job container `build.sh` reaches the registry by the `hobo-ci-registry` container's bridge address (`127.0.0.1` there is the container's own loopback) and loads the layout with `docker load` when the image has no `skopeo`. Change detection diffs `HEAD~1..HEAD` on a depth-2 checkout (the previous main commit on push, the base on a pull request's merge commit) with `grep`. It is skipped on `merge_group`, so a queue entry never retags `hobo-ci-worker:local` from an unmerged group commit; a pull request that changes the image inputs does retag it, but only after the runner contract passes inside the candidate. GHCR publishing runs on main only. `PR impact gate` and `Main full gate` declare `needs: ci-runner-image` (with `!cancelled()`), so a run that changes the image inputs starts its gate on the image it just built.

**Host disk between jobs.** A job's work dir and `/tmp` live in its `--rm` container and go with it. What outlives a job is on the host engine behind the mounted socket. `ci-runner-preflight`, which every hobo job runs first, prunes untagged images over a day old and stopped `hobo.ci/isolated=1` containers over ten minutes old, then prints `docker system df`. Tagged images, the base build's layer cache and the `hobo-ci-registry` volume are kept, so an image rebuild stays warm; unlabelled containers on the host are never touched. The cold dev loop job installs only what its script imports (2.2 GB streamed into the offline container instead of 4.6 GB).

**GHCR (optional, public repos):** the same workflow can push `ghcr.io/<owner>/<repo>/hobo-ci-worker:<version>` after `docker login`.

**Preflight:** every `runs-on: hobo` job starts with `.github/actions/ci-runner-preflight` (`scripts/ci-runner-preflight.mts`). Failures mean the worker image is stale — rerun `build.sh` on the box.

**CI fabric contract guard** (HoBo CI Fabric `ci-guard` job): `pnpm exec vitest run scripts/test/ci-runner-image-contract.test.ts` after install (not `node --test`).

**Fallback:** if a tool cannot be packaged with `mise oci` (asdf backend, broken vfox hooks), use `Dockerfile.monolithic` and document why — see `packages/ci-gh-actions/deploy/ci-runner/README.md`.

```sh
export HOBO_CI_WORKER_IMAGE=hobo-ci-worker:local
node --import tsx packages/ci-gh-actions/scripts/isolated-worker-daemon.mts
```

**Graceful stop:** send **`SIGTERM`** (systemd/Kubernetes preStop). The daemon stops polling for new lease work, **waits for any in-flight poll tick to finish**, then waits until no lease on this worker's offers is launching, registering or running a job, reconciling before each check without admitting new work (default **`HOBO_CI_WORKER_DRAIN_TIMEOUT_MS=1800000`**, 30 minutes; the supervisor's stop timeout, such as systemd `TimeoutStopSec`, must be longer). A repeated `SIGTERM` does not cut the drain short. It then closes the store (SQLite file or Postgres pool) and exits **`0`** when drained or **`1`** on timeout.

Job containers run as **`1000:1000`**; when the host Docker socket is mounted, **`createCliDockerDriver`** adds **`--group-add`** for the socket’s gid so in-container **`docker`** can talk to the engine (see **`cli-docker-driver.ts`**).

Job containers are created with **`--init`**. Their PID 1 is `sleep infinity`, which ignores `SIGTERM`, so without an init every **`docker stop -t 30`** ran its full 30 s while the finished lease still held its slot — and the poll tick reconciles leases serially, so that stop also delayed the next launch. Across 43 post-parallel runs the gap between a slot freeing and the next queued job starting had a median of **48 s** (p90 82 s). The change takes effect only after the box daemon is redeployed.

Force-stop settlement on the box worker **re-queues the reserved job** when GitHub still shows it **`queued`** (for example the ephemeral runner picked up a different workflow job first); the store dedupes pending demand.

**Runner exit frees the slot.** The JIT runner takes one job and exits, but the container (`sleep infinity`) keeps running. `startRunner` therefore writes **`/tmp/hobo-ci-runner-exited`** once `run.sh` returns, whatever its status. Each tick, reconcile checks for the marker with `docker exec <id> test -e` (30 s timeout; a failed check is retried, never treated as an exit) and stops and settles the lease. A slot no longer waits for the job poll (`HOBO_CI_JOB_POLL_MS`) to report the job completed, and a runner that died without taking a job no longer holds its slot until the lease's maximum runtime. Settlement requeues the reserved job when GitHub still shows it `queued`. A job can create the marker itself, but that only ends its own container early.

**Memory:** each job container defaults to **`8192` MiB** (`docker create --memory`); override with **`HOBO_CI_WORKER_MEMORY_MB`**. Workflow sets **`HOBO_TURBO_CONCURRENCY=1`** so turbo **`test`** tasks stay serial on 8 GiB boxes; **`@hobo/cli`** also sets Vitest **`maxWorkers: 1`**. Keep **`NODE_OPTIONS=--max-old-space-size=3072`** (do not raise heap to compensate — RSS from subprocesses dominates). The Main full gate's `check:all` step sets **`HOBO_RELEVANT_CHECK_CONCURRENCY=1`** (one root Vitest fork): four forks plus componentize-js `wizer` were OOM-killed in the job container. The box daemon runs **`HOBO_CI_WORKER_SLOTS=2`** × **`HOBO_CI_WORKER_MEMORY_MB=6144`** on a 15 GiB host (peak ~12 GiB observed). If `test:unit` ends with exit 1 and no Vitest summary, look for `run-tests: vitest was killed by <SIGNAL>` in the log: `scripts/run-tests.ts` names the signal when its Vitest child dies without an exit status.

Legacy path `packages/ci-gh-actions/deploy/worker/Dockerfile` is deprecated; use **`build.sh`** above.

This preserves PR isolation without Sandbox spend.

From [`packages/ci-gh-actions/ONBOARDING.md`](../ci-gh-actions/ONBOARDING.md):

> The Vercel composition enables the isolated host only when Sandbox is explicitly configured. Without that configuration, isolated onboarding and dispatch fail closed.

PR CI (**HoBo CI Fabric** on `pull_request`) is always in this bucket for a public repo.

### 4. JIT label contract

- Workflows must use exactly one runner label: **`hobo`**, or **`hobo-trunk`** for the jobs of `push`, `workflow_dispatch` and `merge_group` runs. The relay rejects jobs with extra runner labels. Each JIT runner registers with the one label its lease's job asked for (`packages/ci-gh-actions/src/runner-labels.ts`).
- `hobo-ci.yml` asks for `hobo-trunk` only while the repository variable **`HOBO_CI_TRUNK_RUNNER`** is `true`; `scripts/lint-actions.ts` allows that one expression and `runs-on: hobo`, nothing else. Redeploy the box daemon on a main that serves `hobo-trunk` before setting the variable: an older daemon ignores the label, and trunk jobs would wait for a runner nobody launches.
- Registered JIT runners must match **`hobo-{uuid}`** name pattern (see acceptance workflow).

### 5. Budget and concurrency

Relay returns **`waiting-for-budget-or-capacity`** when account/provider budget or concurrency is exhausted. Check relay logs and policy API; queued GitHub jobs will not start until a reservation succeeds.

Capacity goes out in admission order, not arrival order: `merge_group`, `push` and `workflow_dispatch` jobs first, then pull-request jobs, then `schedule`, and within each the run that started first. The poller primes each run's event and start time from the run lists it already reads, without another GitHub request; a later lookup failure retains that rank. Within a run, the box daemon admits the job expected to take longest first: the median of that job name's last five successful durations, which the job poller learns from the jobs lists it already reads. A job with no history counts as 0, and the job id breaks any remaining tie. The history lives in memory and is re-learned from the two-hour completed-runs lookback after a restart. A running job is never preempted, so a merge-queue job queued behind two busy PR jobs starts on the next free slot. Reservations and reserved-lease launches both use this order.

**`HOBO_CI_WORKER_TRUNK_SLOTS=1`** (default 0, at most `HOBO_CI_WORKER_SLOTS - 1`, with the offer's `concurrency` equal to `HOBO_CI_WORKER_SLOTS`) sets aside slots for `push`, `workflow_dispatch` and `merge_group` jobs. Other runs then hold at most `HOBO_CI_WORKER_SLOTS - HOBO_CI_WORKER_TRUNK_SLOTS` active leases. **`HOBO_CI_WORKER_TRUNK_LEND=1`** (default 0) lends that spare capacity while no trunk job waits. Once one is pending without a lease, the cap applies; unlaunched non-trunk reservations above it are cancelled newest first and requeued so trunk can reserve in the same pass. Leases with a launched host or running job are never cancelled. If GitHub gives a trunk runner to another job, the original queued job becomes pending again and takes the next free slot rather than waiting for the borrowed runner to finish.

Label separation is still required for GitHub to hand a trunk runner to the trunk job: after redeploying the box daemon with **`HOBO_CI_WORKER_TRUNK_SLOTS=1`**, set repository variable **`HOBO_CI_TRUNK_RUNNER=true`**. Under the shared `hobo` label GitHub can still give that runner to an older PR job ([finding 13](../../docs/ci/performance.md#finding-13-github-gave-the-runner-launched-for-main-to-an-older-pr-job)). The daemon change and its `HOBO_CI_WORKER_TRUNK_*` settings take effect only after a box redeploy. See [finding 9](../../docs/ci/performance.md#finding-9-a-freed-slot-went-to-whichever-job-the-worker-saw-first), [finding 11](../../docs/ci/performance.md#finding-11-a-runs-long-pole-was-admitted-last), and [finding 15](../../docs/ci/performance.md#finding-15-trunk-jobs-starved-for-16-minutes).

### 6. Merge queue (landing, not pickup)

**Merge queue** requires branch protection on `main` with merge queue enabled and the required HoBo CI checks. **Main full gate** is not one of them and does not run on `merge_group` (it runs on the push to `main`), so a queue entry holds no slot for it. That gates **merge** after jobs complete; it does not cause **`queued`** by itself.

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

Workflow YAML in this repository is already **`runs-on: hobo`**; a permanently **`queued`** run means **no JIT runner registered**, almost always because the relay did not admit or launch the job.

## Quick probe (repo script)

```sh
node --import tsx scripts/ci/verify-relay-dispatch.mts
# optional: --relay https://hobo-ci.vercel.app --repository Hobo-Labs/HoBo
```

Exit **0** only when **`GET /readyz`** returns JSON **`{"ready":true}`** (HTTP 200). As of the last operator check, **`https://hobo-ci.vercel.app/healthz`** was **`{"ok":true}`** while **`/readyz`** returned **`{"ready":false}`** — isolated JIT dispatch stays off until readiness clears (Sandbox env, worker health, database — see [`packages/ci-vercel/README.md`](../ci-vercel/README.md)).
