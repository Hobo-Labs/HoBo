---
type: Reference
title: "Release pipelines"
description: "Independent, hermetic release pipelines for ts-autocode, the HoBo SDK, HoBo Code, and the HoBo CLI and PWA, including OCI artifacts, caching, npm scope mapping, one-job pull-request dry runs."
tags: [hobo, release, ci, npm, oci, mise]
---

# Release pipelines

Four release pipelines ship independently: **ts-autocode**, **HoBo SDK**, **HoBo Code**, and **HoBo CLI + PWA**. A release in one pipeline neither triggers nor requires a release in another. Versioning, tags, and release approval follow each pipeline's own cadence.

Most release jobs have a **10-minute hard timeout** and a **5-minute target duration**; the pull-request jobs that build images or run the HoBo Code suite, and the publishing jobs, use their explicitly documented larger budgets (for example **30 minutes** for `release-hobo` / `release-contract` and **20 minutes** for `release-code` / `code-release` (the repo-wide job cap; the suite fits it from Turbo cache, and a cold cone that cannot is a failure to fix, not a budget to raise)). Jobs use **`runs-on: hobo`** and the hermetic worker image. Every third-party GitHub Action is pinned to a **full commit SHA**; mutable version tags are not sufficient.

### Main train version policy (Nerdbank.GitVersioning)

HoBo’s **fixed `@hobo-labs/*` train** does **not** take its semver from a human-pushed `v*` tag anymore. [`version.json`](../../version.json) pins the base train to **`0.0.0-alpha.{height}`** with a **`versionHeightOffset`** so new releases stay above legacy hand tags (`v0.0.0-alpha.0` … `v0.0.0-alpha.2` remain immutable). **[Nerdbank.GitVersioning](https://dotnet.github.io/Nerdbank.GitVersioning/)** (`nerdbank-gitversioning` npm CLI + **`dotnet`** pinned in [`release/mise.toml`](../../release/mise.toml), not root [`mise.toml`](../../mise.toml)) computes **`VersionHeight`** from git; [`scripts/ci/compute-release-version.mts`](../../scripts/ci/compute-release-version.mts) maps that to **`HOBO_RELEASE_*`** (`npm` dist-tag **`alpha`**, never **`latest`**, no stable semver).

**Changesets prerelease mode** stays in the repo for changelog tooling but was **not** chosen for the main train: [`docs/plans/0018-npm-publish-design.md`](../plans/0018-npm-publish-design.md) requires a **single fixed train** across contract-coupled packages, and Changesets expects per-package bump intent (`.changeset/` files) rather than deterministic git-height versioning.

After **`HoBo CI Fabric`** is green on a **`main`** push that touches the [`release-hobo` path filters](../../.github/workflows/release-hobo.yml), **`release-hobo`** runs via **`workflow_run`**: gate job → npm/GHCR/Pages publish at the computed semver → **`release-tag`** pushes a **signed** `v0.0.0-alpha.N` tag and opens a **prerelease** GitHub Release. The **`release-main-train-gate`** job uses the hermetic **`ci-runner-preflight`** toolchain (root `mise.lock`) plus a bounded **`scripts/ci/ensure-nbgv-toolchain.mts`** step (5-minute timeout, heartbeat logs) to install **`release/mise.toml`** `dotnet` only when missing—not **`jdx/mise-action`**, which can hang silently on self-hosted runners under storage pressure. Failed publishes do not move tags; the next green run gets a higher height. Independent **`sdk-v*`** / **`cli-v*`** tags still use [`resolve-release-version.mts`](../../scripts/ci/resolve-release-version.mts).

`release-hobo` and `release-code` jobs (including **`release-main-train-gate`** before **`compute-release-version`**) run `pnpm run pins:fetch ts-autocode` after checkout and before `pnpm install`, matching HoBo CI's sibling-pin setup (sparse **`hobo-checkout`** uses **`pins:fetch`** instead of `submodules: recursive` on tag releases, which avoids promisor fetch failures). `release-hobo` also listens on **`merge_group`** (same path filters as pull requests) so merge-queue checks run the contract job; checkout steps must not duplicate YAML keys under `actions/checkout` `with:` (GitHub rejects the workflow with zero jobs). **`pnpm run actions:lint`** parses every enabled workflow with strict YAML (`uniqueKeys`), rejects repo-local **`uses: ./.github/actions/...`** before **`actions/checkout`**, and verifies third-party action SHAs against **`scripts/action-pin-allowlist.json`** (offline) with authenticated GitHub API + **`git ls-remote`** fallback for pins not yet allowlisted. Sparse release checkouts use **`.github/actions/hobo-checkout`** (blob:none **directory cones** plus a follow-up **`git checkout HEAD --`** for repo-root lockfiles listed in [`RELEASE_ROOT_FILES`](../../scripts/lib/release-sparse-cone.mts); those paths are passed through a step **`env`** because multiline `GITHUB_OUTPUT` must not expand inline in `run:`). Cone mode cannot treat `mise.toml` as a directory). Self-hosted **`hobo`** runners require a one-line **`actions/checkout`** bootstrap of **`.github/actions`** before the first **`hobo-checkout`** step so composite actions resolve. Pull requests and merge-queue entries that touch release paths must pass **`HoBo release PR gate (required)`** in addition to **`Release contract + affected OCI images`**; add both check names to branch protection so a broken release train cannot merge silently. CI and the deps image export **`SOURCE_DATE_EPOCH` as Unix seconds**; `@hobo/componentize` accepts seconds or ISO timestamps before determinism guards run.

Pull requests may build and inspect release artifacts, but any npm packaging is **`npm pack --dry-run` only**. PRs never publish, never write to npm, and never receive publish credentials. For npm staging, a PR `HOBO_RELEASE_VERSION=pr-N` maps to the valid semver `0.0.0-pr.N`; **`pr-manual`** (merge queue / `workflow_dispatch` without a PR number) maps to **`0.0.0-pr.manual`**; optional **`merge-<slug>`** maps to **`0.0.0-merge.<slug>`**. Strict release-tag parsing still rejects those refs for publish.

PR OCI builds are **affected-only, keyed by build inputs**: [`scripts/ci/release-oci-affected.mts`](../../scripts/ci/release-oci-affected.mts) hashes an input key for every manifest image from the git trees of the merge base (`HOBO_CHECK_BASE`, default `origin/main`) and of HEAD, and prints the images whose key changed. The detector uses scoped `releaseInputGitTree` pathspecs (not full-repo `ls-tree`), reads each blob batch through one `git archive` pack transfer instead of lazy per-blob promisor fetches, memoizes trees/`parseLockfile`, and indexes package blobs only within each image's lockfile closure (see [`scripts/test/release-oci-affected.test.ts`](../../scripts/test/release-oci-affected.test.ts)). The key covers:

- the image's Dockerfile directory and manifest entry, plus the manifest's top-level fields;
- the release build scripts (`build-release-oci-image.mts`, `stage-release-oci-app.mts`, `stage-sdk-artifacts.mts`, the contract libraries), `tsconfig.base.json`, `pnpm-workspace.yaml` and `.npmrc`;
- the worker toolchain the Dockerfiles build `FROM`: `mise.toml`, `mise.lock` and `packages/ci-gh-actions/deploy/ci-runner/`;
- the **Turbo build inputs** of every workspace package in the image's `pnpm-lock.yaml` importer closure (the root importer included, since packages build with its `tsc`), filtered by `turbo.json`'s `build` task inputs or the package's own `<name>#build` override, so tests, Markdown and contracts never rebuild an image; a closure package inside a submodule is keyed by the submodule commit;
- the **lockfile slice** that closure resolves: its importer blocks and every snapshot and package entry they reach, plus the lockfile settings. A dependency bump rebuilds only the images that ship it;
- the root `package.json` fields pnpm reads (`packageManager`, `pnpm`, `engines`) and the `turbo.json` build fields, so a script or test-task edit rebuilds nothing;
- inputs the lockfile graph cannot see, listed per image: the SDK's scope map and publish script, and the site's `examples/try-site/`, `examples/browser-runtime/`, `packages/runtime/` and `packages/runtimes/runtime-wasm/`, which it reads by path;
- for `hobo-mcp`, the key of `hobo-cli`, which it is built `FROM`.

SDK overlay tarballs are laid into the pnpm-deploy app with [`installSdkTarballsIntoApp`](../../scripts/ci/stage-release-oci-app.mts): **`tar` extract** in [`orderedSdkTarballPaths`](../../scripts/ci/stage-sdk-artifacts.mts) order (`MANIFEST.json`, including **`@hobo/policy`** before **`@hobo/contracts`**). Do not run **`npm install`** on the deploy tree — npm's arborist crashes on Node 24 when reconciling tarballs against pnpm's injected **`file:`** workspace links. [`stageSdkArtifactsDir`](../../scripts/ci/stage-sdk-artifacts.mts) runs a Turbo **`build`** for the full SDK allowlist before **`npm pack`** (`releaseSdkTurboBuildArgv` honors **`HOBO_TURBO_CONCURRENCY`**, default **`100%`**), so tarballs such as **`@hobo/bindles`** always ship compiled **`dist/`**. `--explain` prints which group changed per image; `--only=` and `--exclude=` filter the result, and `--all` selects every image for manual dispatch. `release-code` builds only `hobo-code` and `release-hobo` excludes it, so no image is built twice for one PR. `@hobo/hobo` depends on `@hobo/code` at runtime, so a `packages/code/**` change does select `hobo-cli` and `hobo-mcp` when `release-hobo` runs. Its PR trigger paths still cover release, toolchain and root inputs only, not package sources.

### One job per pull request, per pipeline

The box has two `hobo` slots, and every job pays its own checkout (about 70 s against GitHub's git endpoint) and install (20 to 40 s) before it does any work, then waits for a slot. A PR that touched both pipelines used to queue 13 jobs, among them four Vitest shards of 13 to 18 s of tests each and one job per image. So each pipeline now runs **one PR job**:

- `release-hobo` / `release-contract` (30 minutes) runs the contract tests and the npm pack dry run, selects the affected images other than `hobo-code`, then builds them through the Turbo cache, checking each with the live OCI config contract. On pull requests the job builds non-`hobo-cli` / non-`hobo-mcp` images **serially** (`HOBO_TURBO_CONCURRENCY=1` on the OCI step) to stay within the ~16 GiB worker memory budget, then runs **`hobo-cli` and `hobo-mcp` serially** (after `hobo-sdk` staging) so SDK overlay and CLI candidate ordering stay deterministic. SDK overlay extracts tarballs under the deploy app dir (same device as pnpm-store staging) and falls back to copy when `rename` hits `EXDEV`. A failing image does not stop the others; the job fails at the end and names them.
- `release-code` / `code-release` (20 minutes, the repo-wide job cap) runs the contract tests, lint, the whole `@hobo/code` suite through `turbo run test --filter=@hobo/code`, and the `hobo-code` image build when its inputs changed. The test step has a 20-minute hard timeout (`timeout -k 30s 20m`), Vitest `testTimeout` / `hookTimeout` default to two minutes per test (`HOBO_TEST_TIMEOUT`), and the package teardown kills tracked subprocess groups plus orphaned `evidence-sidecar-main.js` workers whose `HOBO_HOME` dir is already gone so a hung PTY or sidecar cannot hold a runner for 14+ minutes.

Both diff the PR merge commit against `HEAD^1`, its base tip, so the checkout needs `fetch-depth: 2` instead of the full history. OCI staging combines the SCM-affected Turbo filter `--filter=...[HEAD^1...HEAD]` (changed packages plus dependents) with each requested image's build filter and dependency cone. The image filter keeps an unchanged image package scheduled so Turbo cache hits restore its required `dist` output without rebuilding the full repository; tag and local builds without a resolved base use only the image filters. The affected-image allowlist also prevents staging an image the workflow did not select; the contract step appends only the prerequisite id (`hobo-sdk` before `hobo-cli`/`hobo-mcp`, `hobo-cli` before `hobo-mcp`) for those prerequisite builds so a CLI-only change does not trip the guard on its SDK base. A PR that edits a pipeline's own workflow builds every image that pipeline owns, because the workflow is how they are built.

## Hermetic build model

The worker image starts from a **digest-pinned base image**. Pinned `mise.toml` and `mise.lock` inputs produce **one OCI layer per tool** through `mise --locked oci build`. Pipelines compose only the layers they need instead of maintaining separate monolithic images. Healthy jobs perform no tool installation; preflight can repair an older image by installing only missing tools from the checkout's lockfile before enforcing the contract.

```mermaid
flowchart TB
    Base["Digest-pinned base image"]
    Lock["mise.toml + mise.lock"]
    Node["Node OCI layer"]
    Pnpm["pnpm OCI layer"]
    Turbo["Turbo OCI layer"]
    Other["Other pinned tool layers"]

    Base --> Node
    Base --> Pnpm
    Base --> Turbo
    Base --> Other
    Lock --> Node
    Lock --> Pnpm
    Lock --> Turbo
    Lock --> Other

    Node --> SDK["HoBo SDK composed image"]
    Pnpm --> SDK
    Turbo --> SDK
    Node --> Code["HoBo Code composed image"]
    Pnpm --> Code
    Turbo --> Code
    Node --> CLI["HoBo CLI + PWA composed image"]
    Pnpm --> CLI
    Turbo --> CLI
    Node --> TSA["ts-autocode composed image"]
    Pnpm --> TSA
    Other --> TSA

    SDK --> SDKArtifact["Input-keyed SDK OCI artifact"]
    SDKArtifact --> CLI
    Code --> CodeArtifact["Input-keyed hobo-code OCI artifact"]
    CLI --> CLIArtifact["Input-keyed CLI + PWA OCI artifacts"]
    TSA --> TSAArtifacts["Input-keyed ts-autocode package artifacts"]

    SDK -.-> TurboCache["Turbo remote cache"]
    Code -.-> TurboCache
    CLI -.-> TurboCache
    TSA -.-> TurboCache
```

A tool layer is reusable across **both HoBo and ts-autocode** when the relevant lock inputs match. Matching locks therefore produce cache hits across repository and pipeline boundaries; differing locks select different layers rather than mutating a shared environment.

Each package's OCI artifact is keyed by its complete build inputs, including source, relevant lockfiles, package metadata, and composed tool layers. Turbo remote cache avoids repeating build and test tasks, but it does not replace the input-keyed release artifact: release jobs materialize and verify the artifact selected for the exact release inputs.

The **CLI + PWA pipeline pulls the SDK's OCI artifact**. It never rebuilds the SDK from source. This keeps the SDK boundary explicit and prevents a CLI release from silently publishing or packaging a different SDK build.

## Pipeline responsibilities

| Pipeline | Owns | Release relationship |
|---|---|---|
| ts-autocode | Its publishable packages and package OCI artifacts | Releases on the upstream repository's cadence |
| HoBo SDK | The allowlisted HoBo SDK packages and SDK OCI artifact | Releases independently; supplies the immutable artifact consumed by CLI + PWA |
| HoBo Code | `@hobo/code` / `@hobo-labs/code`, the `hobo-code` binary, and its OCI image | Releases independently on `code-vX.Y.Z`; does not run SDK or CLI releases |
| HoBo CLI + PWA | CLI and PWA artifacts built against a selected SDK artifact | Pulls the SDK artifact; never builds SDK source |

## HoBo Code pipeline

[`.github/workflows/release-code.yml`](../../.github/workflows/release-code.yml) owns the fourth pipeline. Its independent release cadence uses **`code-vX.Y.Z`** tags; the shared **`vX.Y.Z`** CLI/SDK tag does not publish HoBo Code.

- Pull requests trigger only for `packages/code/**`, the `hobo-code` image definition, release manifests and scope mapping, code-related release scripts and contract tests, the workflow and attestation action, or this document. Draft-proof paths under `src/draft/**` are not release inputs.
- Sparse checkout cones are canonical in [`scripts/lib/release-sparse-cone.mts`](../../scripts/lib/release-sparse-cone.mts); [`scripts/test/release-sparse-cone.test.ts`](../../scripts/test/release-sparse-cone.test.ts) fails when a workflow cone omits root vitest setup files (`test/setup/`), pins inputs (`tools/pins/siblings.json`), OCI contract paths derived from `release/oci-images.json` and the release contract vitest suite, or directory cones from `releaseOciInputSparseCones()` required by the OCI detector's scoped git reads. HoBo Code sparse jobs use the full `deploy/` cone, not only `hobo-code`.
- Release workflow `pull_request` path filters include runner contract scripts (`scripts/lib/ci-runner-contract.mts`, `scripts/ci-runner-preflight.mts`, `.github/actions/ci-runner-preflight/`) so preflight fixes re-run the static contract jobs.
- Changed shell scripts in release/CI paths must pass `bash -n` and `shellcheck` via `pnpm run lint:shell:changed` (shellcheck is pinned in `mise.lock` and invoked with `mise exec`, not the host PATH; release contract preflight runs `mise install` before the runner contract). Sparse PR checkouts use `fetch-depth: 2` and diff shell changes with `--base=HEAD^1` (the merge base tip already in the clone), not `origin/main`. The HoBo CI Fabric `CI runner image (mise oci)` job runs `ci-runner-preflight`, then `pnpm-store` + root `pnpm install --ignore-scripts` (the checkout has no ts-autocode submodule), then `lint:shell:changed --base=HEAD~1` before `build.sh`.
- One `code-release` job runs the npm scope-map and OCI manifest contract tests, then lint, which is exactly `pnpm --filter @hobo/code lint`.
- The same job runs the whole suite unsharded as `turbo run test --filter=@hobo/code` with `HOBO_TURBO_CONCURRENCY=1` and the job's **20-minute** budget. `@hobo/code#test` depends on its own build and on `@hobo/hobo#build` and `@hobo/adapter-hono#build`, so Turbo builds that cone first and replays it, and an unchanged suite, from cache. Outside pull requests it then packs dist trees from every pnpm workspace member, including the sibling `external/ts-autocode` packages, for the publish job.
- PR OCI work runs `release-oci-affected.mts --only=hobo-code`, builds the image locally from the cone already built, and never pushes.
- `code-v*` tags, pushed or manually dispatched on the tag, restore the same build artifact, stage `@hobo/code` as **`@hobo-labs/code`** and run `npm pack --dry-run`, then push `hobo-code` to GHCR without rebuilding its dependency cone and attach provenance and SBOM attestations. A dispatch on a tag is a release operation, not a dry run. A dispatch on a branch runs `code-release` only: the publish and attest jobs need a `refs/tags/code-v*` ref, because a branch name is not a release version.
- HoBo Code is developed on the long-lived **`feature/hobo-code`** branch. Pull requests into it get this pipeline's `code-release` lane and HoBo CI Fabric's PR impact gate, judged against that branch's tip (`github.event.pull_request.base.sha`), and pushes to it run Main full gate and its workspace test shards (`main_workspace_tests`) against the branch's own last green push on HoBo CI Fabric, else its previous tip: the `main-gate-plan` job and `scripts/ci/resolve-main-test-base.mts` search the pushed branch's runs (`GITHUB_REF_NAME`), not main's, whose last green commit is an ancestor of this branch after every sync. Nothing publishes from the branch: the runner-image GHCR push needs `refs/heads/main`, the HoBo Code publish jobs need a `code-v*` tag, and the merge queue, the nightly sweep, the deps-image promotion and the SDK/CLI release train stay main-only. Its Main full gate queues in the same concurrency group as main's, so at most one full gate holds a box slot and the short required jobs keep the other; it does ask for the trunk runner label, as every push-capable job must (`scripts/lint-actions.ts`). Feature-branch PRs deliberately skip the `release-pricing` npm dry-run and the `release-ts-autocode` pin-cone check: both validate the main release trains, and the branch publishes nothing. Merging `main` into the branch follows [the sync procedure](#syncing-main-into-featurehobo-code).

The **SDK and CLI + PWA pipelines do not run HoBo Code tests or lint**. `@hobo/hobo` may still compile against the published `@hobo-labs/code` package at release boundaries without running HoBo Code's 5k+ test suite; that compilation is not a substitute for the independent `release-code` test gate.

## npm publication

Public packages publish under **`@hobo-labs/*`** through the **`hobodev`** npm publisher identity. The source workspace keeps its existing **`@hobo/*`** package names and workspace dependency graph.

[`release/npm-scope-map.json`](../../release/npm-scope-map.json) is the explicit source-to-public package mapping. [`scripts/ci/npm-publish-scope.mts`](../../scripts/ci/npm-publish-scope.mts) applies that mapping to the release manifest **at the publish boundary only**, in the packaging/publish staging area. It must not rewrite checked-in workspace manifests, source imports, or the workspace lockfile. Dry-run packing exercises the same staged manifest transformation without publishing so the inspected tarball matches the public package name and mapped dependencies.

Real publication requires:

- **GitHub-hosted `release-npm` job** on **`ubuntu-24.04`** (`timeout-minutes: 20`, same overall 20-minute fail budget) with **`environment: release`**, **`permissions.id-token: write`**, and **`npm publish --provenance`**. When **`NPM_TOKEN`** is empty, npm **trusted publishing** (OIDC) is used — [npm does not support trusted publishing on self-hosted runners](https://docs.npmjs.com/trusted-publishers). Optional **`NPM_TOKEN`** on the **`release`** environment still maps to **`NODE_AUTH_TOKEN`** + **`hobodev`** `whoami` (OpenSesame-style dual path; see Tyler-R-Kendrick/OpenSesame `.github/actions/publish-npm-package`).
- Each **`@hobo-labs/*`** package on npmjs needs a **trusted publisher**: org **`Hobo-Labs`**, repo **`HoBo`**, workflow **`release-hobo.yml`**, environment **`release`**. First publish may require a one-time bootstrap (manual package create or token) before OIDC can attach.
- **`release-npm` is off until npm is bootstrapped.** No `@hobo-labs/*` package exists on npmjs yet and `NPM_TOKEN` is empty, so every main-train run failed at `npm publish` with `ENEEDAUTH` and took the tag and GitHub Release down with it (the last train tag was `v0.0.0-alpha.2`; run 43059319805). The job now runs only when the repository variable **`HOBO_NPM_PUBLISH`** is `true`; while it is unset, `release-tag` tags and releases without it, and once it is `true` a failed npm publish blocks the tag again, and an `sdk-v*` GitHub Release needs npm to have published (a `cli-v*` tag never publishes to npm, so it does not wait on it). To turn it on: either add an **`NPM_TOKEN`** for the `hobodev` publisher to the `release` environment, or publish each package once by hand and add the trusted publisher above; then set `HOBO_NPM_PUBLISH=true`.
- **Tag signing and GitHub Releases need nothing from the runner.** The release runners carry no OpenSSH client and no `gh` (the runner image installs packages without recommends), so `git tag -s` and `gh release create` could not have run there. [`push-release-git-tag.mts`](../../scripts/ci/push-release-git-tag.mts) writes the annotated tag object itself and signs it in Node ([`scripts/lib/ssh-sig.mts`](../../scripts/lib/ssh-sig.mts), the `sshsig` format git writes for `gpg.format = ssh`, Ed25519 only), naming `github-actions[bot]` as tagger; `git verify-tag` with an allowed-signers file accepts it. Both scripts run under plain `node` (type stripping only), so they and `ssh-sig.mts` use erasable TypeScript; `release-git-tag.test.ts` runs them that way. It needs **`HOBO_RELEASE_TAG_SSH_PRIVATE_KEY`** (an unencrypted OpenSSH Ed25519 key) on the `production` environment; **`HOBO_RELEASE_TAG_SSH_SIGNING_KEY`** is optional; when set it must hold that key's public half, and the job refuses to sign otherwise. It accepts the line `ssh-keygen -y -f <key>` prints (`ssh-ed25519 AAAA… [comment]`), with or without git's `key::` prefix or quotes, or a git `allowed_signers` line for it. A value it cannot read fails with what it looks like (a private key, a fingerprint, a known OpenSSH key type such as `ssh-rsa`, or how many fields it has), never any part of the value: a key type is named only when the first word is exactly one, so an `sk-…` API key pasted by mistake is not echoed past GitHub's exact-value log masking. Release run [43236508916](https://github.com/Hobo-Labs/HoBo/actions/runs/43236508916) published and attested every image, then stopped here: the secret held something that did not start with `ssh-ed25519`. [`create-github-release.mts`](../../scripts/ci/create-github-release.mts) creates the release through the REST API and leaves an existing one alone.
- **The train releases what changed since the last release, not what the last commit changed.** `release-main-train-gate` runs [`check-release-relevant-push.mts`](../../scripts/ci/check-release-relevant-push.mts) `--since-last-release`: it diffs the nearest `v[0-9]*` tag in the green commit's history against that commit and releases when a release path changed in between, and it refuses a shallow checkout, which would hide the tags. It used to diff `head^..head`, so a commit whose own `main` run never finished (it was cancelled by the next push until [finding 113](../ci/findings/0113-main-ci-starved-by-cancel-in-progress.md); now a `main` push that waits behind a running one is dropped when a newer one arrives), or that landed behind another in one merge-queue batch, never shipped unless a later commit also touched a release path. #1894's release fixes were one such commit: the green run that followed them changed only `.github/actions/ci-trace`. A commit that is itself already tagged skips, so repair a release that tagged but failed afterwards with **Re-run failed jobs** (it reuses the gate's answer), not **Re-run all jobs**. Train runs after a green `main` push share one `hobo-release-train-push-success` concurrency queue: one runs, the newest waits, and older waiting runs are dropped, so the next one asks after the running release has tagged. Completions that were not green (a dropped or failed `main` run, which the gate skips) queue apart, so they never replace a waiting release. A history with no release tag in it releases. On `main` today the nearest tag is `v0.0.0-alpha.2`, the last train release, and release paths have changed since.
- **Release image builds pull the worker image themselves.** `Build all OCI images on tag` and `Publish GHCR images` run `ensure-ci-worker-image.mts` with the job's `GITHUB_TOKEN` (`packages: read`); without it an ARC pod, which never holds the image, refused the release with `release path requires published ghcr.io worker`.
- **Unmapped public package** or failed pack/provenance precondition still fails closed. PR dry runs receive neither token nor OIDC publishing permission.

These pipelines replace **`workflows-disabled/publish.yml`**; implementation must not leave that disabled workflow as a second, divergent publish path.

## GHCR hostable images

Release pipelines publish **composable app images** on top of the same **mise OCI toolchain** as `hobo-ci-worker` (see [`packages/ci-gh-actions/deploy/ci-runner/build.sh`](../../packages/ci-gh-actions/deploy/ci-runner/build.sh)). Image definitions live in [`release/oci-images.json`](../../release/oci-images.json); build entrypoint is [`scripts/ci/build-release-oci-image.mts`](../../scripts/ci/build-release-oci-image.mts).

Release OCI apps are staged on the runner by [`scripts/ci/stage-release-oci-app.mts`](../../scripts/ci/stage-release-oci-app.mts): the host installs the frozen workspace with lifecycle scripts disabled, builds the image's Turbo targets, and materializes production deploys, SDK tarballs, or site output under `deploy/release-images/.staging/<image-id>/`, or under the configured pnpm store when it is on the same device. The selected staged directory is the Docker build context. OCI builds are serialized on self-hosted runners, staging uses a deploy-only `.dockerignore` context, and Dockerfiles never recursively chown deployed `node_modules` trees. Unknown image IDs fail before the staging directory is replaced. Release Dockerfiles are runtime-only and copy staged artifacts; they never run `pnpm install` or Turbo.

Release run 41724528781 hit ENOSPC while `hobo-cli` deploy copied both Copilot Linux architecture packages across filesystems; skip-build staging measured **2.0 GiB and 64,367 files** before the fix. Every deploy stage now passes `--cpu=current --os=current --libc=current`, retaining only build-host-native optional packages while preserving the production deploy. Deploy is `--prefer-offline`, not `--offline`: pnpm deploy re-resolves direct dependencies, and a frozen install does not cache the registry metadata that resolution needs, so `--offline` only ever worked on the persistent fleet store and fails on clean ephemeral runners. A cold-cache deploy therefore depends on registry reachability for any metadata or tarballs missing from the store; versions and integrity stay pinned by the shared `pnpm-lock.yaml` the deploy resolves against. The same x64 staging measured **1.5 GiB and 64,150 files** afterward (809 packages instead of 817), with only x64 Copilot present; an explicit arm64 control retained only the arm64 package. With `npm_config_store_dir` set, staging also verifies a same-device store directory, stages beneath `<store>/.hobo-release-staging/<image-id>/<run-id>/` with `--config.package-import-method=hardlink`, and records the exact run directory for repeated cleanup; otherwise it keeps in-repo staging and pnpm's default import method. Local `df --output=used` measurements grew by **1,709,732 KiB with copy** versus **56,120 KiB with hardlinks** (96.7% less new disk usage). Wrappers and `.dockerignore` are newly created files, never in-place modifications of deployed hardlinks.

| Image | GHCR name | Role |
|---|---|---|
| `hobo-cli` | `ghcr.io/hobo-labs/hobo/hobo-cli` | Product `hobo` binary |
| `hobo-code` | `ghcr.io/hobo-labs/hobo/hobo-code` | HoBo Code harness and `hobo-code` binary |
| `hobo-mcp` | `ghcr.io/hobo-labs/hobo/hobo-mcp` | stdio MCP (`hobo-mcp`) |
| `hobo-codegen` | `ghcr.io/hobo-labs/hobo/hobo-codegen` | `@hobo/schema-tools` codegen CLI |
| `hobo-ci-serve` | `ghcr.io/hobo-labs/hobo/hobo-ci-serve` | CI relay (`/readyz` on 8787) |
| `hobo-site` | `ghcr.io/hobo-labs/hobo/hobo-site` | Astro docs/PWA static server |
| `hobo-sdk` | `ghcr.io/hobo-labs/hobo/hobo-sdk` | Allowlisted SDK tarball layer (CLI/PWA consume **by digest**) |

**ts-autocode** images publish under **`ghcr.io/tyler-r-kendrick/...`** until the upstream repo moves into `hobo-labs` (same contract tests and mise-layer model).

### Image config requirements

Each Dockerfile sets:

- **`USER 1000:1000`**, **`WORKDIR`**, **`ENTRYPOINT`/`CMD`**, documented **`ENV`** (see manifest `envDoc`)
- **`EXPOSE` + `HEALTHCHECK`** for servers (`hobo-ci-serve`, `hobo-site`; non-server images omit them)
- **`VOLUME`** for mutable state (`.hobo`, relay SQLite, `/work/out`, `/sdk/out`)
- OCI labels: `org.opencontainers.image.source`, `version`, `revision`, `licenses`, plus `io.hobo.release.*`. **`org.opencontainers.image.version`** is the staging semver from **`releaseSemverFromEnv`** (e.g. `HOBO_RELEASE_VERSION=pr-1720` → `0.0.0-pr.1720`; merge-queue `GITHUB_REF_NAME` like `gh-readonly-queue/main/pr-1720-<sha>` → `0.0.0-merge.pr-1720-<sha7>`). The live config contract reads **`HOBO_RELEASE_*` only** (not `GITHUB_REF_NAME` at module load).

Multi-arch builds are **native-only** on `hobo` runners (amd64 or arm64 per box); no QEMU matrix unless a future runner pool adds it for free.

### Tags, digests, and pipeline references

- CLI/SDK release tags: **`sdk-v…`** / **`cli-v…`** independent trains still use an explicit git tag → GHCR/npm via [`resolve-release-version.mts`](../../scripts/ci/resolve-release-version.mts). The **main `@hobo-labs/*` train** uses **[Nerdbank.GitVersioning](../../version.json)** (`compute-release-version.mts` after green **`main`**) → semver like **`0.0.0-alpha.N`**, GHCR tag **`v0.0.0-alpha.N`**, signed tag pushed **after** publish by **`release-tag`**. Prerelease images **never** receive a `:latest` tag. Legacy tags **`v0.0.0-alpha.0`–`v0.0.0-alpha.2`** are never moved or deleted.
- npm: prerelease semver (e.g. `0.0.0-alpha.0` derived from the tag) publishes with **`npm publish --tag <prerelease-id>`** (`alpha` for `-alpha.0`), so **`latest`** stays reserved for stable `vX.Y.Z` releases without a prerelease segment. Staged `@hobo-labs/*` tarballs take their **`version`** field from `HOBO_RELEASE_SEMVER` / the parsed tag, not the workspace `0.0.1` dev versions; **`applyScopeToManifest`** pins mapped **`workspace:*`** dependencies to that semver before **`npm pack`**, and CLI/MCP OCI staging installs SDK tarballs **one tarball at a time** into the deploy tree.
- HoBo Code release tags: **`code-vX.Y.Z`** → `hobo-code:code-vX.Y.Z` and an immutable digest, independent of CLI/SDK tags.
- **`v0.0.0-alpha.N` (main train)** runs **`release-pages`** and **`release-tag`** (signed git tag + prerelease GitHub Release) after npm/GHCR publish; it is **not** triggered by pushing `v*` tags. Tag/workflow_dispatch OCI staging shallow-fetches **`origin/main`** when present; otherwise it builds the full importer closure with no Turbo affected base. **`release-pages`** no longer rides the train gate: **`release-pages-gate`** runs [`scripts/ci/check-release-pages-stale.mts`](../../scripts/ci/check-release-pages-stale.mts) after every green **`main`** push and publishes when the commit **`gh-pages`** names is behind the commit under release and a release path changed in between, so a deploy that failed, was cancelled, or belonged to a commit batched behind another is picked up by the next green run ([finding 110](../ci/findings/0110-a-failed-pages-deploy-was-never-retried.md)). It never publishes a commit older than the one already live; one publish runs at a time (`hobo-release-pages` concurrency) and re-asks once it holds the slot. The gate runs on a sparse checkout before any install, so it uses Node built-ins only. **`release-tag`** does not wait on this run's publish: a skipped publish (already newer) or one cancelled because a newer run took its place in the queue still tags, while a failed publish or a gate that failed to decide does not; the deploy commit is `deploy: <built sha>`; the published tree is `site/dist` with the `hobo-media` catalogue nested under `/media/`, the same tree [`scripts/deploy-site.mts`](../../scripts/deploy-site.mts) publishes. **`workflow_dispatch`** with **`publish_pages`** (from **`main`** only) publishes on request. **`release-pages`** sparse checkout uses **`RELEASE_PAGES_SPARSE_PATHS`** (includes **`examples/`**, **`media/`**, and workspace **`packages/`** cones). It runs [`scripts/ci/build-release-site-prebuild.mts`](../../scripts/ci/build-release-site-prebuild.mts) (Turbo **`hobo-site...`**, always the whole closure, about 2 minutes on a fresh runner. An affected-since-`origin/main` filter failed with `no merge base found` on the shallow checkout once `main` had moved past the release commit, [finding 125](../ci/findings/0125-release-pages-affected-build-without-merge-base.md)) before **`hobo-site`** prebuild so try-site apps resolve built **`@hobo/bindles`** / **`hobo`** dist. **`release-main-train-gate`** computes height once (full history); **`release-publish`** / **`release-npm`** shallow-checkout and call [`materialize-release-version.mts`](../../scripts/ci/materialize-release-version.mts) **after** **`pnpm install`**, which **trusts gate `HOBO_RELEASE_VERSION`** under **`HOBO_RELEASE_VERSION_MODE=nbgv`** instead of re-running nbgv VersionHeight (shallow clone lacks ancestor objects). Sparse checkouts retry partial-clone fetches over HTTP/1.1.
- Downstream pipelines (CLI + PWA) **pin the SDK image by digest**, never `:latest`.
- PR workflows **build + contract-test** images locally; they **do not push** to GHCR.
- Tag/`workflow_dispatch` releases push with **`GITHUB_TOKEN`** (`packages: write`); no new secrets.
- **`release-publish`** is a matrix with one image per job over the release train's images (listed by the `release-images` job: all six for `v*`, `hobo-sdk` for `sdk-v*`, `hobo-cli` and `hobo-mcp` for `cli-v*`), one job at a time (legs on one box share the `*:candidate` tags). Each leg builds or reuses its GHCR tag via [`push-release-ghcr-images.mts --image <id>`](../../scripts/ci/push-release-ghcr-images.mts) (registry reuse when the tag already exists and `org.opencontainers.image.revision` matches this run, [finding 138](../ci/findings/0138-release-attest-missing-digest-after-cancel.md)), then uploads a non-empty `hobo-release-digest-<id>`: `ghcr.io/…/<id>@<digest>`, with the digest from `docker push` or the matching `RepoDigests` entry (never `RepoDigests[0]`; [finding 141](../ci/findings/0141-release-digest-read-the-local-name.md)). The **`release-oci-build-tag`** matrix is a **gate**, not a digest artifact handoff. Registry **`unknown blob`** / transient HTTP failures retry with exponential backoff before failing the train; each push attempt is stopped after 4 minutes and retried, all attempts together get 8 minutes and none starts with under a minute left, so a stalled push fails its leg inside the 20-minute job limit instead of being cancelled by it ([finding 121](../ci/findings/0121-release-publish-stalled-push-hit-job-limit.md)).
- **Main train signed tags** use **`environment: production`** secrets **`HOBO_RELEASE_TAG_SSH_PRIVATE_KEY`** (private key material for SSH signing) and **`HOBO_RELEASE_TAG_SSH_SIGNING_KEY`** (public **`user.signingkey`** for `gpg.format=ssh`, e.g. `ssh-ed25519 AAAA… comment`). Deploy keys are disabled: **`release-tag`** signs with SSH but **pushes the tag over HTTPS** with the job’s **`GITHUB_TOKEN`** (`contents: write`). The job refuses to move an existing tag.

### Signing, SBOM, and provenance

- **GitHub artifact attestations** (keyless, no cosign secret): after GHCR push and `docker login`, [`.github/actions/release-oci-attest`](../../.github/actions/release-oci-attest) resolves each digest, runs `actions/attest-build-provenance`, then runs **pinned `syft`** from root [`mise.toml`](../../mise.toml) to emit a CycloneDX JSON SBOM for `subject-name@subject-digest` (the scan retries on a bounded budget while a just-pushed GHCR digest becomes readable; provenance attests first so a syft failure cannot kill it), then `actions/attest-sbom` (with `sbom-path`) — one provenance + SBOM attestation pair per image (pinned SHAs in [`.github/workflows/release-hobo.yml`](../../.github/workflows/release-hobo.yml) and [`.github/workflows/release-code.yml`](../../.github/workflows/release-code.yml)). The shared [`.github/actions/release-oci-attest`](../../.github/actions/release-oci-attest/action.yml) composite **docker-logs into GHCR first** (`~/.docker/config.json`) because `push-to-registry: true` on self-hosted **`hobo`** runners does not inherit login from the publish job; attest jobs use **`packages: write`**. Release contract jobs (not the attest jobs) run **`ci-runner-preflight`** first: `syncMissingMiseTools` prepends the bin dir of each `mise.toml` tool that `PATH` cannot already see (on a stale image, **`syft`**) onto `PATH` and `$GITHUB_PATH` via `mise which`, so `command -v syft` succeeds after a shell-level `mise install` on an image that predates the syft layer; tools already visible keep their existing resolution. Attest jobs run no preflight: the composite installs locked `syft` itself (`mise install --locked syft`), so it needs `mise` on `PATH` and the root `mise.toml` in the checkout. Adding a tool to `mise.toml` changes the runner-image version, so merge it with (or before) a runner-image rebuild; until then fresh-container jobs pay a per-job locked install of the new tool.
- npm packages continue to use **`npm publish --provenance`** (OIDC) on the same release train.

### Contract tests

[`scripts/test/release-oci-image-contract.test.ts`](../../scripts/test/release-oci-image-contract.test.ts), [`scripts/test/release-oci-attest-contract.test.ts`](../../scripts/test/release-oci-attest-contract.test.ts) (SBOM/provenance composite: `registry:` scan source, locked syft install, provenance-before-SBOM order, bounded retry, CycloneDX shape, `sbom-path` wiring; run by both `release-hobo.yml` and `release-code.yml` release-contract steps and listed in `RELEASE_CONTRACT_VITEST_FILES` for sparse-cone derivation), [`scripts/test/ci-runner-image-contract.test.ts`](../../scripts/test/ci-runner-image-contract.test.ts) (preflight missing-tool install + PATH-invisible-only bin export), and [`scripts/test/release-version.test.ts`](../../scripts/test/release-version.test.ts) validate:

1. Manifest + Dockerfile presence (always), including the explicit `hobo-code` entrypoint, state volume, and environment documentation
2. Release ref parsing, npm dist-tag selection, and GHCR tag rules (no `:latest` on prereleases)
3. **`docker inspect`** config vs expected `USER`, `WORKDIR`, `ENTRYPOINT`, `EXPOSE`, `VOLUME`, labels when **`HOBO_RELEASE_OCI_CONTRACT=live`**
4. The declared help/version probe inside the candidate container as non-root

Local:

```bash
pnpm exec vitest run scripts/test/release-oci-image-contract.test.ts scripts/test/release-version.test.ts scripts/test/stage-release-oci-app.test.ts
```

The full `@hobo/hobo` pnpm deploy + SDK overlay probe lives in [`scripts/test/stage-release-oci-app.deploy-integration.test.ts`](../../scripts/test/stage-release-oci-app.deploy-integration.test.ts) (main-gate / local; Vitest timeout **360s**; too slow for release contract). Release workflows include [`scripts/test/release-contract-vitest-scope.test.ts`](../../scripts/test/release-contract-vitest-scope.test.ts) so that file never joins the PR release vitest list.

`releasePnpmStore` runs `pnpm store path` in the workspace so the returned directory matches pnpm v10's versioned store (for example `/pnpm-store/v10` when `npm_config_store_dir=/pnpm-store` is mounted on the box worker). It falls back to `npm_config_store_dir` only when `pnpm` is unavailable. Release workflows wrap the Vitest lane in [`scripts/ci/run-job-command-report.mts`](../../scripts/ci/run-job-command-report.mts) so failures still write the tail of the log to `$GITHUB_STEP_SUMMARY` and upload `/tmp/hobo-ci-job-logs/release-contract-vitest.log` when GitHub does not retain runner logs.

```bash
bash packages/ci-gh-actions/deploy/ci-runner/build.sh
node --no-warnings scripts/ci/build-release-oci-image.mts hobo-cli --keep-candidate
HOBO_RELEASE_OCI_CONTRACT=live HOBO_RELEASE_OCI_IMAGE_ID=hobo-cli pnpm exec vitest run scripts/test/release-oci-image-contract.test.ts
node --no-warnings scripts/ci/build-release-oci-image.mts hobo-cli --cleanup-only
```

Set `HOBO_RELEASE_OCI_IMAGE_ID` to each built image id, or omit it after building every manifest image to run all live contracts in one invocation. `HOBO_RELEASE_VERSION` and `HOBO_RELEASE_REVISION` must match the candidate build when supplied.

`--keep-candidate` must not run `docker builder prune` before the live contract step: pruning after `docker build -t …:candidate` can drop the tag on the self-hosted store before `release-oci-image-contract.test.ts` calls `docker image inspect`. Builder prune runs only on `--cleanup-only` (or a build without `--keep-candidate`).

[`release-ts-autocode.yml`](../../.github/workflows/release-ts-autocode.yml) verifies the pinned ts-autocode sparse cone on **`ts-autocode-v*.*.*`** tags (npm pack dry-run only; upstream owns publication). Its sparse checkout includes the HoBo **`packages/`** cone so root `pnpm install` can link `ts-autocode-grounding` into `@hobo/runtime` after `pnpm run pins:fetch ts-autocode`; contract tests in [`scripts/test/release-sparse-cone.test.ts`](../../scripts/test/release-sparse-cone.test.ts) gate the cone and step order.

## ts-autocode upstream migration

Upstream [`Tyler-R-Kendrick/ts-autocode`](https://github.com/Tyler-R-Kendrick/ts-autocode) currently uses **`setup-node` + `npm ci`** and has no mise-based toolchain. Its target release model is:

1. Add pinned **`mise.toml` + `mise.lock`** inputs.
2. Run CI and release jobs on **`runs-on: hobo`** with the same digest-pinned, mise-layered worker-image model as HoBo.
3. Remove **`setup-node`** and **Corepack** setup from those jobs; tools come from the composed image, not runtime installation.
4. Publish its packages under **`@hobo-labs/*`** with the same scoped-publish and provenance rules.
5. Keep HoBo consumption through the pinned **git submodule sparse cone**, not through a source rebuild in the CLI pipeline or an unpinned upstream checkout.

The sparse cone remains limited to the workspace members declared by HoBo's sibling-pin configuration. Publishing upstream packages does not change HoBo's source-consumption boundary by itself.

## Syncing `main` into `feature/hobo-code`

This branch keeps hobo-code (`packages/code`, `@hobo/code`, the `hobo-code` binary); `main` removed it in #1772 (squash commit `930d37a34`). `main` is merged in from time to time so the branch keeps up with the platform.

The first sync is done, and it recorded the removal as merged without applying it. A plain merge would have deleted hobo-code from this branch too. With `R` = `930d37a34`, it was:

```bash
git switch feature/hobo-code
git fetch origin
git merge --no-ff "$R^"                    # main up to just before the removal
git merge -s ours --no-ff "$R"             # the removal: recorded as merged, not applied
```

Every later sync is `git merge origin/main`. Check it with `git merge-base --is-ancestor 930d37a34 HEAD`: if that fails, the `-s ours` merge is not in this branch's history and an ordinary merge would delete hobo-code. When a `main` change touches a file the removal rewrote (an ADR, these release docs, `@hobo/patterns`), resolve the conflict so this branch keeps its hobo-code content.

**A sync is pushed as merge commits, or landed from a pull request with "Create a merge commit". It is never squash-merged or rebased.** A squash turns the `-s ours` merge into an ordinary commit, so git no longer records `R` as merged, and the next ordinary sync applies the removal: it deletes most of `packages/code` and conflicts on the rest. A rebase drops the merge commits the same way.

**A conflict in `pnpm-lock.yaml` is resolved by pnpm, not by hand.** Keeping both sides of a hunk can drop a snapshot and leave others that nothing reaches; `pnpm install --lockfile-only` returns without re-resolving and `--frozen-lockfile` ignores orphans, so neither notices. Take either side, then run `pnpm install --lockfile-only --fix-lockfile` with the pinned pnpm, and keep only the hunks the merge needs (a proxy or mirror can strip `deprecated:` lines). The result is right when every snapshot is reachable from an importer, no snapshot reference dangles, and the difference from `main`'s lockfile is the hobo-code importers and what only they need.

**This branch is never merged back into `main` wholesale.** `main` has no hobo-code, and a merge of this branch would bring all of it back. hobo-code changes go to this branch only; a platform change made here that `main` also needs goes to `main` as its own pull request and comes back with the next sync.

## Related references

- [npm publish allowlist](../design/npm-publish-allowlist.md)
- [0018: npm publish path — release engineering design](../plans/0018-npm-publish-design.md)
- [HoBo runner queue troubleshooting](../../packages/ci/RUNNER-QUEUE.md)
