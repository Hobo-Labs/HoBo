---
type: Implementation Plan
title: "HoBo CI: prebuilt checkout and install layers"
description: "Phased plan for Kimi K3.1 to make HoBo CI jobs start from a local git mirror and lockfile-keyed OCI layers in GHCR instead of a network checkout and pnpm install, with hermetic builds as the governing principle."
tags: [hobo, ci, oci, mise, pnpm, ghcr, hermetic, performance]
---

# HoBo CI: prebuilt checkout and install layers

Status: **Phases 3 and 4 implemented in the reduced legacy-builder form described below**; the other phases
remain planned. The implementation preserves the content-keyed, offline-verified design but does not claim the
unmeasured acceptance targets or deferred hardening.

Related: [`performance.md`](./performance.md) (where wall time goes),
[`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md) (box worker runbook),
[`packages/ci-gh-actions/deploy/ci-runner/README.md`](../../packages/ci-gh-actions/deploy/ci-runner/README.md)
(runner image), and the release images in
[#1674](https://github.com/Hobo-Labs/HoBo/pull/1674) (`docs/release/pipelines.md` on that branch).

## Principle: hermetic builds, cached by content

This principle applies to every project the box builds: **HoBo, ts-autocode, OpenSesame and OpenPacker**.
Only HoBo was audited for this plan. The other three adopt the same acceptance criteria, but their current state
is unknown here.

1. **Pinned toolchains.** Tools come from `mise.toml` plus `mise.lock` (exact version, per-platform URL and
   checksum). Nothing on `PATH` comes from an unpinned installer.
2. **Content-addressed layers keyed by their inputs.** A layer's tag is a hash of exactly the files that
   determine it: `mise.lock` for toolchains, the lockfile and manifests for dependencies, and the commit for
   source. Equal inputs mean the same tag, so every repository and pipeline gets the same hit. Different inputs
   mean a new tag; a layer in use is never mutated.
3. **No network during a build beyond pinned fetches.** A fetch is allowed only when the bytes it can return are
   pinned by a digest or an integrity hash. Examples are a base image `@sha256:…`, a `mise.lock` checksum, a
   `pnpm-lock.yaml` `integrity`, or a release asset with a pinned SHA-256. Every other build step runs with
   `--network=none`.
4. **Reproducible outputs.** The same inputs produce the same layer digest:
   - `SOURCE_DATE_EPOCH` is fixed for the artifact family (`0` for deps buckets), not the commit's time, so unchanged content keeps its digest across commits;
   - the deps build uses `rewrite-timestamp=true` only when the default `docker build` invocation advertises it;
     otherwise the fixed epoch and explicit Dockerfile `touch` provide the timestamps;
   - file order and ownership are fixed;
   - no build step embeds a clock, a hostname or a random value.

### Hermeticity acceptance criteria (every phase, every project)

- [ ] Every image, action and tool is pinned:
  - images by `@sha256`;
  - GitHub Actions by full commit SHA (`scripts/lint-actions.ts` already enforces this);
  - tools by `mise.lock`.
- [ ] Each layer tag is derived by one pure function of declared input files. The function is unit-tested, and a
  test fails when an input that changes the layer is left out of the key.
- [ ] Build stages after the pinned fetch run with `RUN --network=none`. A test or lint fails on an unpinned
  `curl`/`wget`/`apt-get` in any Dockerfile or build script the plan touches.
- [ ] Building the same inputs twice on the box, with the cache disabled, yields the same layer digest. The
  check is a scripted rebuild in the phase's PR evidence, run with `docker buildx build --no-cache`.
- [ ] Known gaps are either fixed or listed in "Hermeticity gaps" with an owner phase. Nothing is silently
  waived.

### Hermeticity gaps today (HoBo)

| Gap | Where | Fixed in |
|---|---|---|
| `apt-get update && apt-get install` resolves today's Debian package versions | `deploy/ci-runner/base/Dockerfile` | Deferred toolchain hardening: `snapshot.debian.org` at a pinned date, or a version-pinned `system-packages.txt` |
| `registry:2` is pulled by tag | `deploy/ci-runner/build.sh` | Deferred toolchain hardening: pin by digest |
| `curl https://mise.run \| sh` runs an unpinned installer script (only the version is pinned) | `deploy/ci-runner/build.sh` | Deferred toolchain hardening: pinned mise release asset with its SHA-256 |
| `pnpm install` on every job links every package even with a warm mounted store | every job | **Implemented Phase 4:** prebuilt `node_modules` layer; Main full gate and PR impact gate skip on an exact key match and install on every miss |
| Cache-off layer-digest equality and actual push savings still need box evidence | `deploy/ci-runner/deps/Dockerfile` and `build-deps.sh` | Phase 5 verification: all copied files have a fixed epoch; the default `docker build` enables `rewrite-timestamp=true` only when its help advertises it |

## Why: the data from main run 41690661790 (237 s)

### Checkout

`actions/checkout` took **42–70 s** per job in this run. On 2026-11-02 the same steps took **4–9 s**.

The regression is **not** a configuration change. The same commands with the same inputs ran fast earlier on
2026-11-03:

| Job | Fetch command | 12:52 UTC (run 41639013863) | 18:09 UTC (run 41690661790) |
|---|---|---:|---:|
| Main full gate | `fetch` of all branches and tags at full depth, then the submodule clone | 2.8 s + 0.5 s | 51 s + 17.5 s |
| CI fabric contract guard | `--depth=1` fetch, then the submodule clone at depth 1 | — | 18 s + 36 s |
| CI runner image | `--depth=2` fetch | — | 41 s |
| Secret scan | full-history fetch of all refs | — | 45 s |

Checkout times across all 41 runs since 13:00 UTC climb steadily from about 15:00. Every job is affected, at
every fetch depth, whether or not other jobs are running. The slowdown reproduces off the box, from an unrelated
cloud VM, at 18:3x UTC:

- `git ls-remote` of a tiny repository took 9.2 s.
- A depth-1 clone of `ts-autocode` (640 KB of `.git`) took 11 s.
- A depth-1 HoBo clone took 27 s, and a full bare HoBo clone 41 s.
- The same tree as a codeload tarball arrived at 10 MB/s, in 4.8 s.

So the time is **per request on GitHub's git smart-HTTP endpoint**, not bandwidth and not the box. githubstatus
showed "All Systems Operational" throughout.

**Conclusion:** any design that makes a round trip to github.com's git endpoint on a job's critical path will
inherit that variance. Sparse plus `blob:none` shrinks the bytes but not the round trips. A **local mirror**
removes them.

Locally, from a bare mirror on the same disk:
- `git clone --shared` plus a full checkout took **1.5 s**;
- the same with a sparse cone took **0.09 s**;
- `git log -p` over 20 commits took **0.03 s**.

### Install

`pnpm install --frozen-lockfile` took **19 s**, and nothing was downloaded: the store is the host-mounted
`HOBO_CI_PNPM_STORE_MOUNTED` store. The time splits into:

| Phase | Time |
|---|---:|
| Resolve | 1.5 s |
| Link 2,031 packages from the store | 7 s |
| Link 796 workspace importers and their bins, plus lifecycle scripts | 9 s |
| Root `prepare` | 1 s |

A `pnpm fetch` layer alone would therefore save **about 0 s on the box**, which already has a warm store. The
saving comes from **not linking at all**: a prebuilt `node_modules` layer, checked by an offline install that
finds it up to date.

### Slots

The image job also waited **78 s for a slot**. That is a scheduling problem and is out of scope here;
see [`performance.md`](./performance.md).

## Rubber duck: options and tradeoffs

### Where the git objects come from

| Option | Critical-path round trips to github.com | Verdict |
|---|---|---|
| Status quo: full-depth fetch of all refs | 2+ (refs plus pack), and a full-history pack | Remove: no job but Secret scan needs history |
| Sparse plus `filter: blob:none`, depth 2 | 2+, plus lazy blob fetches | Do it (Phase 1). It cuts bytes, not latency |
| `--reference` or alternates to a box mirror, still fetching from GitHub | 1–2 (negotiation), tiny pack | Partial: latency stays |
| **`insteadOf` to the box mirror, fetched once by the worker before the job starts** | 0 when the mirror has `GITHUB_SHA` | **Chosen (Phase 2)**, falling back to GitHub when the mirror misses |
| Per-commit "post-checkout" source layer in GHCR | 0 for git, but a registry pull per commit | Reject: one image per commit churns GHCR, and the mirror already gives 1.5 s |

The mirror is **one bare repository per project** on the box, for example
`/var/lib/hobo-ci/git/Hobo-Labs/HoBo.git`, mounted **read-only** into every job container.

Only the box worker writes it. It fetches `+refs/heads/main`, `+refs/pull/<n>/merge` and `+refs/pull/<n>/head`
for each queued run before launching that run's jobs, which takes one fetch per run instead of one per job. The
merge ref only changes when GitHub recomputes it, so a job whose `GITHUB_SHA` is still missing triggers one
targeted fetch by the worker.

**Fork PR objects can enter the mirror**, because `refs/pull/*` include fork heads. That is safe, because:
- the mirror is content-addressed and read-only to jobs;
- no ref in it is trusted as "main";
- an object only becomes a job's checkout when it is that job's `GITHUB_SHA`.

### What the job starts from

| Layer | Key | Value on the box | Value off the box (other projects, cold runners) |
|---|---|---|---|
| Toolchain: `mise oci build`, one layer per tool | `ciRunnerImageVersion` = hash of `mise.lock`, `mise.toml`, `system-packages.txt`, base `Dockerfile` and `build.sh` | Already local. Saves the 15-minute rebuild after a box rebuild or prune | High: ts-autocode, OpenSesame and OpenPacker reuse a tool layer when their `mise.lock` entries match |
| `pnpm fetch` (store only) | hash of `pnpm-lock.yaml` plus `.npmrc` plus the pnpm version | About 0 s; the store is mounted and warm | High: makes `--offline` installs possible anywhere |
| **Post-install `node_modules`** | depsKey, see below | **About 17 s per job** | Medium. The image is large: whole-workspace `node_modules` is about 4.3 GB uncompressed. Use zstd |
| Source | commit | Low, given the mirror | Low |
| Post-build (`dist/`) | commit, or a hash of every package's inputs | Low: Turbo already replays tasks content-addressed and affected-only | Low for CI. Release images in #1674 are the right home for build outputs. Layer keys skip markdown, tests, and scripts/ci files that are not the image build recipes so a docs or deps-layer edit does not rebuild all six product images. |

**Decision:** toolchain layers in GHCR (Phase 3), a lockfile-keyed fetch-plus-install layer in GHCR
(Phase 4), the mirror for source (Phase 2), and **no post-build layer**.

Turbo stays the build-output cache. It is content-addressed per task, so a one-file change replays every other
task. An OCI layer of `dist/` is all-or-nothing per commit, and would duplicate what Turbo already gives
affected-only runs.

The one Turbo-adjacent idea worth keeping is optional: an `oras` artifact that seeds an empty
`TURBO_CACHE_DIR` on a fresh box or runner. It is read-only for PRs.

### depsKey: what makes a `node_modules` layer stale

The key is sha256 over, in fixed order:
- `pnpm-lock.yaml` and `pnpm-workspace.yaml`;
- every importer's dependency-layout manifest fields: `name`, `version`, dependency and dependency-metadata fields,
  `bundleDependencies`/`bundledDependencies`, `bin`, `directories.bin`, `publishConfig.directory`/`bin`/
  `linkDirectory`, `os`, `cpu`, `libc`, `engines`, `devEngines`, `packageManager`, `workspaces`, `overrides`,
  `resolutions`, and root-only `pnpm`. One normalizer parses each manifest, sorts the retained keys, and supplies both
  the hash and the staged Docker context. Metadata such as scripts, exports, files and descriptions is excluded;
- root `.npmrc`, `patches/**`, and optional `.pnpmfile.cjs`;
- the platform (`linux/arm64` on the box);
- the explicit `DEPS_LAYOUT.version`. Bump it when a layout recipe changes image contents or paths; otherwise only its
  pinned `recipeSha256` changes. The job-side `scripts/ci/deps-layer.mts` is staged into the deps context
  so mount verify can run `link`, but it is not hashed into the key;
- `ciRunnerImageVersion`, which covers `mise.lock`, `mise.toml`, `system-packages.txt`, the base Dockerfile and
  the runner build script, including the Node and pnpm versions.

Main full gate and PR impact gate skip the install only when the worker's `HOBO_CI_DEPS_LAYER` exactly equals the
checkout's computed key. Every miss runs `pnpm install --frozen-lockfile` against the full checkout, including its
lifecycle scripts, so normalization never removes scripts from a fallback install. The image install uses
`--ignore-scripts` followed by its explicit native-package rebuild list, and its `Already up to date` verification
sets `npm_config_ignore_scripts=true`; importer lifecycle scripts therefore cannot affect the produced layer. The
daily scheduled Main full gate always installs as the correctness verifier. Other jobs retain the ordinary install,
which finds a matching layer's `.modules.yaml` current.

Nix and Bazel have the same rule: the key is the full declared input set, outputs are immutable, and a cache hit
is only a speed-up over a build you could have run. Adopt that discipline, not the tools.

### How a job gets the layer: the composition mechanism

The job container is started by the box worker, before the runner knows the job's `GITHUB_SHA`. Options:

1. **The worker picks the job image.** The worker already knows each run's head SHA and has the mirror. It
   computes depsKey with `git show <sha>:<path>` from the mirror. If
   `ghcr.io/hobo-labs/hobo-ci-deps:<toolchain>-<depsKey>` is local, or pullable, it starts the job from that image
   instead of `hobo-ci-worker:local`.
   - The `node_modules` trees sit at the runner's workspace path
     (`/opt/actions-runner/_hobo_work/HoBo/HoBo`).
   - A runner `ACTIONS_RUNNER_HOOK_JOB_STARTED` script initialises `.git` there from the read-only mirror before
     the first step.
   - `actions/checkout` then finds a repository with the right remote, fetches from the mirror through
     `insteadOf`, and checks out with `clean: false`, so the ignored `node_modules` survives. A lint rule
     enforces `clean: false` exactly where a deps layer is in use.
2. Mount the deps image read-only (`--mount type=image`): `node_modules` must be writable (tool caches,
   `.vite`), so this needs an overlay on top. Rejected: more moving parts.
3. Copy or hardlink `node_modules` into place after checkout: on overlayfs both trigger a copy-up of about
   4 GB. Rejected.

**Chosen: option 1.** The worker falls back to `hobo-ci-worker:local` and a normal install whenever the key
cannot be computed or the image is missing.

### Registry and pulls

- **GHCR** under `ghcr.io/hobo-labs`, with **public** packages. GitHub does not bill storage or bandwidth for
  public packages, so there is no paid infra.
  - Images: `hobo-ci-worker:<toolchain>`, `hobo-ci-deps:<toolchain>-<depsKey>`.
  - BuildKit cache: `hobo-ci-deps:buildcache`.
- **default-builder registry cache:**
  - deps builds always use the default builder without `--load`; with `GITHUB_REPOSITORY` set they read
    `--cache-from type=registry,ref=ghcr.io/<repo lowercase>/hobo-ci-deps:buildcache` only when `docker info`
    reports the containerd image store. Classic stores log and skip the import; a missing remote cache is a no-op;
  - after the bounded image push, which uploads only blobs the registry lacks, the separate publisher uses the same
    detection to export `mode=min` through a 120-second bounded rebuild on the default builder. Classic stores and
    unavailable buildx log and skip the export;
  - **PRs only read.** The deps job has `packages: read`, never `packages: write`, and only the publisher uses
    `--cache-to`. `mode=min` exports final-image bucket layers already uploaded by the image push, adding only a
    cache manifest; it does not export the install stage or cache-mount contents, so a lockfile change still reruns
    fetch and install. Box-side cache hits and timings remain unverified here.
- **zstd** layer compression (`compression=zstd,force-compression=true`) cuts pull time and size for the large
  deps layer. Docker 23+ pulls zstd natively.
- **eStargz/SOCI lazy pulls: not now.** They need the containerd image store and the stargz snapshotter. The box
  runs Docker's classic image store, and switching it is a root-level daemon change. A local image only pulls
  once per depsKey, so lazy pulls would mostly help cold machines. Revisit if the box moves to containerd.
- **Local registry mirror on the box: not by default.** With one Docker daemon, its image store already is the
  cache, and a pull-through `registry:2` adds a hop without saving bytes. It becomes worth it with more than one
  daemon or host. `build.sh` already runs a `registry:2` for `mise oci` loads; pin it, and reuse it as a
  pull-through cache only if a second host appears.

### Fork safety, signing, retention

- **Fork PRs are read-only.** `pull_request` jobs get `permissions: packages: read`. They never pass
  `--cache-to` or push, and the existing `head.repo.fork` checks keep secrets out.
- **Same-repository PRs also never push** to canonical tags, so an unreviewed branch cannot poison the cache. Only
  `push` to `main` writes. A scheduled job builds and pushes deps layers for keys seen on open PRs, from
  **`main`'s workflow code** only.
- **Provenance and SBOM:** `actions/attest-build-provenance` and `actions/attest-sbom` (keyless, free for public
  repositories), SHA-pinned, as #1674's `release-oci-attest` already does. Optionally `cosign sign` keyless on
  the digest.
  - **The worker verifies the provenance once per digest before first use.** It runs `gh attestation verify`
    and requires the signer workflow to be `hobo-ci.yml@refs/heads/main`. An unverified image is never used.
  - The verified digest is recorded in the worker's store, so the check is not repeated per job.
- **GC and retention:** a weekly scheduled job uses SHA-pinned `actions/delete-package-versions`. It keeps:
  - the newest 5 toolchain tags;
  - the newest 10 depsKeys, plus any key referenced by an open PR;
  - only the `-main` cache tags.
  It deletes untagged versions older than 7 days.
  - The box prunes local `hobo-ci-deps:*` images not used for 7 days, alongside its existing
    `docker image prune` in `ci-runner-preflight`.
  - Both limits are environment knobs with tests.

### Interactions

- **Sparse checkout** (in progress on `cursor/ci-sparse-checkout-4453`): orthogonal. The mirror serves the
  blobs and the cone limits the working tree. The deps layer covers every importer, so a sparse job has
  `node_modules` for packages it does not check out. That is harmless: pnpm's offline verify only considers
  present importers.
- **Bare mirror:** sparse jobs fetch missing blobs from the mirror (local), not from GitHub. The
  `checkout-cone.mts` widening step becomes local too.
- **Affected-only Turbo:** the mirror holds full history, so `merge-base` and `git diff <base>...HEAD` work
  without `--deepen` or extra fetches. `turbo-scm-base.mts` and `affected-lanes.mts` are unchanged.
- **Secret scan:** it needs history, not a working tree. It gets a blobless clone of the mirror
  (`--filter=blob:none` from a local path) with the cone at the root files. gitleaks' `git log -p` reads blobs
  from the local mirror's objects through alternates. Remote: 0 round trips.
- **Release images (#1674):** they already build `FROM ${HOBO_TOOLCHAIN_IMAGE}`. Phase 3's GHCR toolchain tag
  becomes that argument, pinned by digest, and the release images' input-keyed artifacts stay the only OCI
  home for build outputs. Both use the same key function and the same attest action.

## Estimated time saved per job (against run 41690661790)

The "after" times assume a mirror hit and a deps-layer hit. A miss falls back to today's path.

| Job | Checkout now | Install now | Checkout after | Install after | Saved |
|---|---:|---:|---:|---:|---:|
| Main full gate | 70 s | 19 s | about 2 s (shared clone plus checkout from mirror) | about 2 s (offline verify) | **about 85 s** |
| CI fabric contract guard | 56 s | 19 s | about 2 s | about 2 s | **about 71 s** |
| Secret scan | 47 s | — | about 2 s (blobless local history) | — | **about 45 s** |
| CI runner image | 42 s | — | about 1 s (sparse cone) | — | **about 41 s** (plus about 15 min on any box without the image: pull instead of build) |
| PR impact gate, off-path, artifact-trust, dev-cold-loop (PR runs) | 26–96 s today | 19 s when they install | about 2 s | about 2 s | **about 40–110 s each** |

For main's critical path (image job, then Main full gate), this run would drop from 237 s to about 105 s. That
assumes the same 78 s slot wait; the slot wait is the next target.

These are estimates from the measurements above, not results. Phase acceptance replaces them with measured
numbers.

## Phases

Each phase is **one signed-off squash PR** on `main`:
- open the PR and land it through the merge queue;
- no force-push;
- run `pnpm agent:check -- --staged` before each commit;
- run `pnpm run actions:lint`, and `pnpm run standards:check -- --base=origin/main`, before opening the PR;
- update `docs/ci/performance.md` and `packages/ci/RUNNER-QUEUE.md` in the same PR.

Measurements always come from `main` push runs, as before and after tables of per-job checkout, install and wall
time, read with `gh run view --json jobs` over the 5 runs before merge and the 5 after.

### Phase 0: measurement harness (small PR)

- `scripts/ci/step-timings.mts` (node builtins only) reads `gh run view <id> --json jobs`. It prints per-job
  slot wait (created to started), checkout, install and job wall time, plus the run's wall time, as a markdown
  table.
- Each job logs one `git ls-remote` timing to `https://github.com/<repo>` in its trace span, so GitHub's variance
  is visible apart from ours.
- **Acceptance:** a unit test over a recorded `gh` JSON fixture, and the baseline table for the last 10 `main`
  runs committed to `performance.md`.

### Phase 1: sparse, blobless checkouts

**Status (2026-11-05): started for Main full gate S0 only.** `hobo-ci.yml` bootstraps `.github/actions`, then uses
`hobo-checkout` with `filter: blob:none`, `fetch-tags: false`, the canonical cone in
`scripts/ci/checkout-cone.mts`, and `submodules: "false"`. The cone covers S0, `check:all`, and `agent:check`
inputs but not `media/`. History remains (`fetch-depth: 0`). A main push runs bounded
`gitleaks git --log-opts=before..sha` so the blobless clone does not walk every historical blob
through the promisor (finding 75). The daily schedule and `workflow_dispatch` still run
full-history gitleaks after `git fetch --refetch --no-filter`. Recursive ts-autocode clone stays
off; after preflight the job runs `pnpm run pins:fetch ts-autocode` when the pin cone manifests
are missing so deps-key and `pnpm prepare` can see the workspace importers (finding 74).
Other jobs, including `pr-gate` and the image jobs, are unchanged.

The eventual Phase 1 target remains that every `actions/checkout` uses:
- `filter: blob:none`;
- a `sparse-checkout` cone;
- `fetch-tags: false`;
- a minimal `fetch-depth`;
- no `submodules`.

A later Phase 1 change will derive each remaining job's cone and add the `lint-actions.ts` rule for non-sparse
checkouts. This S0 slice deliberately adds neither the per-job derivation nor that global lint rule.

`hobo-checkout` now also probes a job-side bare mirror named by `HOBO_CI_GIT_MIRROR`, then
`/var/lib/hobo-ci/git/<owner>/<repo>.git` and `/opt/hobo/ci/git/<owner>/<repo>.git`. A hit must contain the exact
`GITHUB_SHA` commit. It writes both GitHub URL forms as `url.file://<mirror>.insteadOf` entries in the
`GIT_CONFIG_SYSTEM` file under `RUNNER_TEMP`, so checkout's pack and lazy blob fetches stay local without changing
the checkout `repository:` or stored `origin`. A miss only logs `hobo_ci_git_mirror=miss` and keeps GitHub as the
remote. The Phase 2 worker fetch, mount, and job-started hook are **not implemented** here.

- **Acceptance for this slice:** `scripts/test/s0-checkout-cone.test.ts` keeps the workflow and cone synchronized,
  and `scripts/test/box-git-mirror.test.ts` proves hit, miss, missing-commit, path-rejection, and CLI behavior.
  The full-repo sparse lint rule and the remaining acceptance comparisons stay with the later Phase 1 work.

### Phase 2: box bare mirror

The worker (`packages/ci-gh-actions` isolated worker) owns `/var/lib/hobo-ci/git/<owner>/<repo>.git`:
- It creates the mirror with `git clone --bare --filter=blob:none` once, then backfills blobs for `main`.
- It runs `git fetch` for each admitted run's refs before launching the run's jobs, through one queue per
  repository. That gives one writer, and keeps `gc.auto` off during jobs.
- It runs `git maintenance run --task=gc` weekly.
- The mirror is mounted read-only into job containers.

The runner image gets:
- `ACTIONS_RUNNER_HOOK_JOB_STARTED=/opt/hobo/ci/job-started.sh`. If the mirror has `GITHUB_SHA`, the hook writes
  `url.file:///mirror/<repo>.git.insteadOf=https://github.com/<repo>` into a system gitconfig named by
  `GIT_CONFIG_SYSTEM`. `actions/checkout` overrides `HOME`, so global config would be lost. Otherwise the hook
  leaves GitHub as the remote.
- Secret scan clones the mirror blobless and scans `before..sha` on push, or `base..head` on a PR. The weekly
  schedule scans full history.

- **Acceptance:**
  - checkout of 2 s or less at p90 on `main` for every job;
  - a test that a mirror miss falls back to GitHub and the job still passes;
  - a test that a job cannot write the mirror;
  - fork PR objects fetched into the mirror are never resolved by a branch name.

### Phase 3: toolchain layers in GHCR

- On `push` to `main` the image job already pushes `ghcr.io/<repo>/hobo-ci-worker:<version>`. Add:
  - provenance and SBOM through the #1674 attest action;
  - zstd compression;
  - buildx `--cache-to` the `-main` registry cache with `mode=max`, and `--cache-from` on every build.
- `build.sh` first tries `docker pull ghcr.io/hobo-labs/hobo-ci-worker:<version>`, verifies its attestation, then
  tags it `:local`. It only builds on a miss.
- Fix the three Phase 3 hermeticity gaps: apt snapshot, `registry:2` digest, and the pinned mise installer.
- Publish the key function (`ciRunnerImageVersion`) as the shared toolchain key for ts-autocode, OpenSesame and
  OpenPacker.

**Implemented in this change (2026-11-04):** `build.sh` now pulls the exact
`ghcr.io/<lowercased GITHUB_REPOSITORY>/hobo-ci-worker:<version>` tag when the local version is missing (default
repository `Hobo-Labs/HoBo`). It tags the pulled candidate and runs the existing in-container runner contract
before promoting `:local`; a registry miss or failed contract takes the native-build path. This is the small
GHCR-consumption slice. Attestation verification stays Phase 5, and zstd/buildx cache publishing plus the three
remaining toolchain pins are deferred hardening rather than claimed here.

- **Acceptance:**
  - a box with the image pruned gets back to `:local` in under 60 s;
  - the image job does no build when the version is in GHCR;
  - two cache-off rebuilds give an equal digest;
  - PR runs show `cache-from` hits and no pushes.

### Phase 4: lockfile-keyed deps layer and offline install

- `scripts/ci/deps-key.mts` computes depsKey, with tests that mutate each input.
- `deploy/ci-runner/deps/Dockerfile` builds in three stages:
  1. `pnpm fetch` from `pnpm-lock.yaml` only (network, integrity-pinned);
  2. `--network=none` copy of every importer's `package.json` and the workspace files, then
     `pnpm install --frozen-lockfile --offline`;
  3. a final stage holding only the `node_modules` trees and deps-key marker under `/opt/hobo-deps`, split into
     stable content-hash buckets.
- A separate non-blocking workflow publishes a local main image only when GHCR lacks its tag.
- The worker picks `hobo-ci-deps:<toolchain>-<depsKey>` per run, as in option 1 of the composition mechanism
  above.
- Job install steps become `pnpm install --frozen-lockfile --offline`, with a fallback to the online install
  when no layer was used. The worker exports `HOBO_CI_DEPS_LAYER=<key>` to the job.

**Implemented in this change (2026-11-04):** the pure key function hashes every installed-dependency input, including
each normalized lockfile importer manifest, plus an explicit layout version. Mutation tests prove that recipe,
link/check script, and Node/pnpm mise edits do not change it; the toolchain prefix already covers `mise.lock`.
`deps/build-deps.sh` stages only the dependency inputs and bucket generator, runs the network-enabled `pnpm fetch`
target, then a separate whole-build `--network=none` install/rebuild. It adds the link/check script only to a separate
offline-verification directory. Both stages reuse the persistent host store through the same
BuildKit cache mount. The install stage stages every repo-relative `node_modules` under `/opt/hobo-deps`; the final
toolchain-based stage adds a deps-key marker, with no `.git`, checkout path, deletion pass, fetch store or staged
manifests. The bucket generator assigns each `.pnpm` entry to one of 64 stable SHA-256 buckets and emits generated
`COPY --link` layers; one residual layer holds workspace links and pnpm metadata. Sorted entries, fixed ownership and
`SOURCE_DATE_EPOCH=0` make unchanged buckets reproducible. The offline `Already up to date` contract and a real
uid-1000 job-mount contract run before promotion to `:local`; cached local/GHCR candidates pass the same mount
contract. Every event reuses an exact local or GHCR hit without building. The worker selects that layer only for HoBo
leases with a matching toolchain label and a successful payload/writability probe, exports its full key, and refuses
mismatched pre-warmed containers. PRs touching the deps-build inputs reuse a keyed hit or exercise build-only mode
without promoting or pushing.

After checkout, `scripts/ci/deps-layer.mts link` symlinks each payload `node_modules` into its repo-relative checkout
path, so the per-lease `_hobo_work` mount no longer hides dependencies and pnpm's relative links keep working.
`prepareJobDirectory` creates and chowns the job root, `HoBo`, and `HoBo/HoBo` to uid/gid 1000. Main full gate and PR
impact gate skip `pnpm install` only when job, checkout, and payload keys match, linked `.modules.yaml` and the
virtual store exist, root and workspace `tsx` resolve, and `pnpm exec tsx --version` succeeds. Every miss runs the
ordinary frozen install; the daily scheduled Main full gate always installs to verify correctness. The skip path
checks the ts-autocode links explicitly. CI already skips root hook installation, and the image's frozen offline
install creates the same workspace bin links and pnpm state as the job install, including bin links that remain
dangling until `dist` is built. Other jobs keep their install-and-verify behavior.

Every main push runs `ci-deps-image`; an exact `hobo.ci.deps-key` label match on `hobo-ci-deps:local` exits after
checkout, key computation, and one inspect, while a miss resolves or builds and promotes the layer. Schedule and
workflow dispatch always run; PR scoping is unchanged. Neither gate depends on the deps-image job. The separate
`ci-deps-publish.yml` workflow starts only after a successful main fabric run or manually, skips absent local and
existing remote tags, cancels superseded publishes, and bounds both the job (five minutes) and `docker push`
(240 seconds). Builds and cache exports use the default builder without `--load`; registry cache import and export
are gated on the containerd image store. After a push, the publisher exports `mode=min` buildcache through a
120-second bounded default-builder rebuild, or logs and skips it on classic stores or without buildx. Registry
failure cannot fail or delay HoBo CI. GHCR retention and attestation verification stay Phase 5. Main-run timing,
default-builder cache hits, layer-digest and push-size evidence are still required before ticking time-based
acceptance boxes.

- **Acceptance:**
  - install of 5 s or less on `main` for every job that installs;
  - a lockfile-changing PR passes on the fallback path;
  - an install-relevant package-manifest-only change gets a new key, while a scripts-only change preserves both the
    key and every staged context byte;
  - the build stage runs with no network (a test greps the Dockerfile, and a buildx `--network=none` run passes).

### Phase 5: signing, fork safety, retention

- The worker verifies attestations before using a toolchain or deps image.
- Add the weekly GHCR retention workflow and the local deps-image prune.
- A lint rule: no `packages: write`, no `--cache-to`, and no `docker push` in any job that can run on
  `pull_request`.

- **Acceptance:**
  - lint tests;
  - a dry-run retention report in the PR;
  - after a week on `main`, GHCR package-version counts stay within the configured bounds.

### Phase 6 (optional): Turbo cache seed artifact

Only if data shows cold boxes or runners paying for empty Turbo caches.

## Execution notes for Kimi K3.1

- Run every phase as `kimi --auto -m kimi-code/k3.1-pro -p "<phase prompt>"` from a fresh branch
  `cursor/<phase>-4453` off `origin/main`. The prompt quotes:
  - the phase section of this file;
  - the hermeticity acceptance criteria;
  - the repo rules in `AGENTS.md`: no `sudo`, SHA-pinned actions, TypeScript `.mts` scripts, docs updated in the
    same PR, `--signoff` on every commit, no force-push.
- The Kimi Code CLI must be logged in first (`kimi login --region global`, a device-code flow a human
  approves). Without it, `kimi -m kimi-code/k3.1-pro` fails with "model is not configured".
- Box-side changes (mirror path, mounts, the `job-started` hook) ship in the worker image and the daemon config
  in the repository. Nothing is configured by hand on the box, and nothing needs root beyond what the worker's
  Docker socket already allows.
- A phase is done when its acceptance boxes are ticked with measured numbers from `main`, not estimates.
