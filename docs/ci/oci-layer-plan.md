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
   - `SOURCE_DATE_EPOCH` is the input commit's time;
   - BuildKit runs with `rewrite-timestamp=true`;
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
| Legacy Docker records build times but cannot rewrite every file timestamp, so equal inputs do not yield byte-reproducible image digests | `deploy/ci-runner/deps/Dockerfile` and `build-deps.sh` | Phase 5: BuildKit `rewrite-timestamp=true` (the box's Debian `docker.io` legacy builder lacks it) |

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
| Post-build (`dist/`) | commit, or a hash of every package's inputs | Low: Turbo already replays tasks content-addressed and affected-only | Low for CI. Release images in #1674 are the right home for build outputs |

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
- every importer's `package.json`, because `bin`, `scripts` and `dependenciesMeta` change linking without
  changing the lockfile;
- root `.npmrc`, `patches/**`, and optional `.pnpmfile.cjs`;
- the `node` and `pnpm` entries of `mise.lock`, because native postinstalls are ABI-specific;
- the platform (`linux/arm64` on the box);
- `ciRunnerImageVersion`, which covers `mise.lock`, `mise.toml`, `system-packages.txt`, the base Dockerfile and
  the runner build script.

Main full gate and PR impact gate skip the install only when the worker's `HOBO_CI_DEPS_LAYER` exactly equals the
checkout's computed key. Every miss runs `pnpm install --frozen-lockfile`, so a wrong key costs time, never
correctness. The daily scheduled Main full gate always installs as the correctness verifier. Other jobs retain
the ordinary install, which finds a matching layer's `.modules.yaml` current.

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
  - BuildKit cache: `hobo-ci-cache:<name>`.
- **buildx registry cache:**
  - pushes from `main`: `--cache-to type=registry,ref=ghcr.io/hobo-labs/hobo-ci-cache:<name>-main,mode=max,compression=zstd`;
  - every build: `--cache-from type=registry,ref=…-main`;
  - **PRs only read.** `mode=max` keeps intermediate stages, such as the `pnpm fetch` stage, so a manifest-only
    change rebuilds just the link stage.
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

Finish `cursor/ci-sparse-checkout-4453`. Every `actions/checkout` uses:
- `filter: blob:none`;
- a `sparse-checkout` cone;
- `fetch-tags: false`;
- a minimal `fetch-depth`;
- no `submodules`.

`scripts/ci/checkout-cone.mts` derives each job's cone from the diff and the `pnpm-lock.yaml` importer graph. A
`lint-actions.ts` rule fails on any non-sparse checkout.

- **Acceptance:** the lint rule and its test. Affected-only Turbo detection gives the same filters as a full
  checkout for the last 25 `main` commits (scripted comparison in the PR). The merge queue stays green.

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
  3. a final stage holding only the `node_modules` trees at the workspace path.
- The image is pushed from `main` and from the scheduled PR-key builder.
- The worker picks `hobo-ci-deps:<toolchain>-<depsKey>` per run, as in option 1 of the composition mechanism
  above.
- Job install steps become `pnpm install --frozen-lockfile --offline`, with a fallback to the online install
  when no layer was used. The worker exports `HOBO_CI_DEPS_LAYER=<key>` to the job.

**Implemented in this change (2026-11-04):** the pure key function hashes every declared input (including each
lockfile importer manifest, the deps build recipe and the Node/pnpm mise entries) with mutation tests.
`deps/build-deps.sh` stages only those manifests, runs the network-enabled `pnpm fetch` target, then a separate
whole-build `--network=none` install/rebuild. Both stages reuse the persistent host store through the same
BuildKit cache mount. The install stage separately stages `node_modules` and `.git`, so the final toolchain-based
stage copies only those trees, with no deletion pass, fetch store or staged manifests. The candidate gets
content/toolchain labels and the commit's `SOURCE_DATE_EPOCH`; the offline `Already up to date` contract runs
before promoting a new build to `:local`. Every event reuses an exact local or GHCR hit without building. The
worker selects that layer only for HoBo leases with a matching toolchain label, exports its full key, and refuses
mismatched pre-warmed containers. Every default-path box checkout sets `clean: false` under a new lint rule.
Main/schedule/dispatch can publish GHCR tags; PRs touching the deps-build inputs reuse a keyed hit or exercise
build-only mode without promoting the new candidate or pushing.

Main full gate and PR impact gate skip `pnpm install` on an exact `HOBO_CI_DEPS_LAYER` match and run the ordinary
frozen install on every miss; the daily scheduled Main full gate always installs to verify correctness. The skip
path checks the ts-autocode links explicitly. CI already skips root hook installation, and the image's frozen
offline install creates the same workspace bin links and pnpm state as the job install, including bin links that
remain dangling until `dist` is built. Other jobs keep their install-and-verify behavior.

On main pushes, `ci-deps-image` is gated to deps-key input changes or a completed `ci-runner-image` build, with
fail-safe builds for missing commit file lists and forced pushes. Schedule and workflow dispatch always run; PR
scoping is unchanged. Main full gate does not depend on the deps-image job, so unrelated pushes add no trunk-slot
wait. GHCR retention and attestation verification stay Phase 5. Byte-reproducible digests are not claimed because
the legacy builder has no BuildKit `rewrite-timestamp`; that gap is recorded above with its owner phase. Main-run
timing evidence is still required before ticking the time-based acceptance boxes.

- **Acceptance:**
  - install of 5 s or less on `main` for every job that installs;
  - a lockfile-changing PR passes on the fallback path;
  - a package-manifest-only change gets a new key;
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
