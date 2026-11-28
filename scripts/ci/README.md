# scripts/ci

Scripts the GitHub workflows under `.github/workflows/` run. Each script's
header comment is its reference; this page collects the ones whose contract
spans several files.

## Hosted Playwright (Fabric overflow)

When a Fabric workspace test shard lands on `ubuntu-24.04`, `ci-runner-preflight`
with `browser: true` always restores or installs the lockfile-pinned chromium
headless shell. The zip is cached under `actions/cache/restore` and
`actions/cache/save` keyed by the lockfile, ci-runner contract, and install
scripts, then unpacked into `${RUNNER_TEMP}/hobo-pw-browsers` with
`PLAYWRIGHT_BROWSERS_PATH` pointing at that directory (never `/opt/pw-browsers`).
Self-hosted `hobo` runners keep the image-baked browsers under `/opt/pw-browsers`.

## Runtime test reaches

Package tests that load another workspace package through a computed path must
declare that edge in `scripts/test-deps-runtime-reaches.json` so Fabric's
`check-test-workspace-deps` gate schedules the right builds. `owner-ceremony-smoke`
names `packages/ci-vercel` at run time; `ceremony-explorer` uses the fake Vercel
CLI path and does not register that reach. CD listener tests that reach
`@hobo/camps` are registered there.

## Draft pull request CI (Nov 2026)

Pull request workflows listen only on `opened`, `synchronize`, `reopened`, and
`ready_for_review` (`examples-e2e.yml` also listens on `labeled` so adding
`hobo/e2e` or `hobo/e2e-quarantine` to a ready pull request can start those
lanes; entry job conditions still skip drafts). The first routing job on each `pull_request`-triggered
workflow carries `github.event_name != 'pull_request' || github.event.pull_request.draft == false`, so a draft schedules no runner jobs. Required aggregate gates
(for example `pr-gate` in `hobo-ci.yml`) run only when the pull request is not a
draft; their scripts fail closed if prerequisites were skipped without an
attestation or merge-group PR Fabric reuse. A ready pull request whose gates are
all green may enter the merge queue; any required failure sends the pull request
back to draft for in-place fixes, then it is marked ready for review again to
re-run CI. `decidePrFabricReuse` treats a green workflow conclusion without an
executed route job or `pr-fabric-tested` artifact as non-reuseable evidence.
Contract tests: `scripts/test/draft-pull-request-workflows.test.ts`,
`scripts/test/pr-fabric-reuse.test.ts`, `scripts/test/merge-group-gate.test.ts`.

## Routing

`route-runner.mts` is the route job of the six routed workflows. It runs on a
GitHub-hosted runner with nothing installed and imports no package source, only
`runner-routing.mts` and the committed `runnerRouting` in `.hobo/ci.json`. It
reads the routing slip at `refs/hobo/routing-slip` with `contents: read`
(ADR-0181); see [the route action](../../.github/actions/route-runner/README.md).

## Fleet service release images

`push-release-service-image.mts` publishes the HoBo Fleet service images
: `hobo-fleet-authority`, `hobo-fleet-witness` and
`hobo-fleet-relay`, built from `deploy/release-images/<id>/Dockerfile`.

- The `release-service-images` job of `release-hobo.yml` runs one image per leg,
  one at a time, on the full release train only (an `sdk-v` or `cli-v` tag
  ships none of them).
- The authority and the witness are staged from `@hobo/fleet-authority` with
  `pnpm deploy`, as `hobo-ci-serve` is. The relay has an empty build context:
  its Dockerfile fetches the pinned, checksum-verified `iroh-relay` itself.
- Each image is exported as an OCI image layout and published as release
  Freight through `hobo deploy`, like the train's other images. The realizer is
  the only thing that pushes.
- The published digest is attested with build provenance and a CycloneDX bill
  of materials by `.github/actions/release-oci-attest` (R18).
- The Freight journal is uploaded as `hobo-service-freight-<id>`, so the release
  tag and the GitHub Release, which read the train's `hobo-release-freight-oci-*`
  journals, do not count these images as part of the train.

`scripts/test/fleet-release-workflow.test.ts` holds the job to this description.

## Release Freight realize

[`create-github-release.mts`](create-github-release.mts) opens release CD with
`releaseWorkflowCredentials`: camps that declare `github-app://<owner>/<repo>`
locators authorize through the workflow job `GITHUB_TOKEN` only when
`GITHUB_REPOSITORY` is set and matches the locator case-insensitively and the
resolver scope is `release-probe` or `cd-realize:<logicalCampId>` (for example
`cd-realize:hobo-release/pages-candidate`, matching pipeline promotion ids;
`releaseWorkflowGithubAppScopeAllowed`).
Blocked release verdicts and `::error::` lines use
`releaseFreightLogFragment` from `@hobo/cd/reconcile` (`@hobo/provider-redaction`
detectors, fail closed) before aggregation or logging.
`announceVerdict` keeps resolver codes (`releaseFreightVerdictCodesForAnnounce`)
and structured GitHub Pages refusal detail on `::error::` lines instead of
`blocked (none)`. The `Record and promote the Pages candidate` step of `release-hobo.yml`,
and the stable job's `Promote the Pages stable channel` step, pass
`GITHUB_TOKEN: ${{ github.token }}` so Pages realize uses the job-scoped
token with `contents: write`, not `secrets.GITHUB_TOKEN`. The `release-contract` job builds those workspace
packages (`RELEASE_CONTRACT_SCRIPT_BUILD_FILTERS` in
`scripts/lib/release-contract-script-build.mts`) before its vitest list so sparse
checkouts have `dist/` without pulling `@hobo/cd` source into the scripts lane.
When `scripts/ci/attested-jobs.json` changes, bump `SHADOW_PLAN_BLOB` in
`attestation.mts` to the git blob id
`scripts/test/attested-jobs.test.ts` asserts. When
`.github/workflows/hobo-ci.yml` changes, bump `SHADOW_WORKFLOW_BLOB` in
`attestation.mts` to `git hash-object` of that file.
Hermetic checks live in
[`scripts/test/release-freight.test.ts`](../test/release-freight.test.ts).
Page and OCI realize behavior is documented in [`packages/hobo/CD.md`](../../packages/hobo/CD.md).
While holding the Pages publish slot, the stable job verifies that `gh-pages`
still names its exact candidate source before promotion. A superseded or
unverifiable source fails the job so it cannot report a stale promotion as passed.
If dependency-layer materialization times out without a complete decision, the
recovery action checks the pnpm store again and installs only when it is warm.

Pages release sparse checkout lists directory cones only in `RELEASE_PAGES_SPARSE_PATHS`
(including `src` for the gh-pages deps checkout-key path and `examples` for
`examples/browser-runtime/wit/station.wit`); `hobo-checkout` routes
nested file paths through `sparse-checkout add`, not cone `set`. The release-pages job also
passes `RELEASE_PAGES_MATERIALIZE_PATHS` so blobless checkouts always run
`sparse-checkout add` plus `git checkout HEAD --` for `examples/browser-runtime/wit`
(even when a reused runner worktree already has the path), verify `station.wit` matches
`HEAD` by blob id, log `ls -la` on the wit tree, and fail closed when the file is absent,
empty, or stale. [`build-release-site-prebuild.mts`](build-release-site-prebuild.mts)
re-runs the same assertion against `HOBO_RELEASE_CHECKOUT_REF` immediately before turbo
builds site `examples:runtime`. [`build-browser-wit-runtime.mts`](../../site/scripts/build-browser-wit-runtime.mts) copies the wit tree
into a workspace-local work root (`.cache/browser-wit-componentize/`, then `realpath`), not `os.tmpdir()`,
and passes `station.wit` inline as `witWorld` to `componentize-js` before componentize. [`browser-wit-componentize-diagnostics.mts`](../lib/browser-wit-componentize-diagnostics.mts)
logs `componentize-js` / `preview2-shim` resolution, `TMPDIR`, `/tmp` mount metadata, runner identity,
and container hints on the release path. Host `readFile` on sandbox `station.wit` passing while
componentize fails indicates a **host vs WASI/preview2-shim view mismatch** (not only sparse checkout:
#2995–#2997 still materialize and byte-compare before componentize). PR job
`release-pages-browser-wit-smoke` on the **`hobo`** runner runs
[`build-release-browser-wit-on-runner.mts`](build-release-browser-wit-on-runner.mts) — the same
prebuild + `examples:runtime` chain as Pages publish, without pushing gh-pages.
The smoke purges `site/public/examples/runtime`, sets `HOBO_BROWSER_WIT_FORCE_COMPONENTIZE=1`,
and requires `.cache/browser-wit-componentize/componentize-proof.json` after build (cold
componentize, not a verified runtime cache hit). Spawn results fail closed on `error`,
`signal`, or non-zero `status` (`spawn-sync-fail-closed.mts`).

`site/src/lib/examples/catalog-contract.ts` parser helpers accept `JsonValue | undefined` so
root `typecheck:root` can follow imports from `site/scripts/build-browser-wit-runtime.mts`.

[`ensure-ci-worker-image.mts`](ensure-ci-worker-image.mts) materialize and digest
resolution contracts are exercised in
[`scripts/test/ensure-ci-worker-image.test.ts`](../test/ensure-ci-worker-image.test.ts).
Release `--resolve-digest` pins the worker only when `docker image inspect` lists
exactly one matching `RepoDigests` entry for `ghcr.io/<repo>/hobo-ci-worker@sha256:<64 lowercase hex>`.
The publisher gives a confirmed manifest up to nine minutes to pull. It rebuilds
only when both the manifest inspection and pull explicitly report a missing image;
timeouts and network errors stop the publisher without overwriting the tag.


## SDK release artifacts

SDK staging validates the runtime workspace dependency closure before building
or packing. Runtime grounding and SQLite internal dependencies are transformed
first and included with their licenses. Every remaining runtime, peer, and
optional workspace dependency must belong to the SDK publish train; otherwise
staging stops before producing a tarball.

Packages stage and pack in up to four isolated workers, with a serial fallback
when a package declares a pack or prepare lifecycle script. The manifest keeps
the SDK allowlist order, and the clean-install acceptance verifier still runs
before the artifacts are accepted.

Published package manifests retain workspace import names as npm aliases for
their public package names. OCI app staging installs matching workspace-name
links so the same packed modules resolve in the deployed app.
Its Turbo builds honor the runner's `HOBO_TURBO_CONCURRENCY` memory limit.
The staging test checks the configured-store fallback with no package manager on `PATH`.


The SQLite SDK includes backend-routing and Fleet implementation code and their
license notices in its tarball. Shared journal errors come from `@hobo/core`,
so a separately installed backend-routing package and the SQLite bundle use the
same constructor when they resolve the same core version.

## CI/CD gauntlet

Run `node scripts/ci/measure-cicd-gauntlet.mts evidence.json` to measure from
CI workflow creation through the last CI or CD workflow or job completion.
The limit is strictly less than 600 seconds. The process exits 1 when the
recorded evidence does not pass and 2 when the input is unusable.

The input combines GitHub Actions run and complete job API responses under
`ci` and `cd`. See `scripts/test/fixtures/cicd-gauntlet/` for captured
examples and the configurable deployable job requirements. Include the
`workflow_run` event for each CD run: it must identify the CI run, SHA and
attempt. Inside Actions, the current CD run reads its event from
`GITHUB_EVENT_PATH` and does not print the event payload. Matching SHAs and
timestamps alone do not prove causality. A CD run cannot pass while it is still
running; retain the event evidence and analyze it after the run completes.

A passing result requires evidence for a warm cache globally and for every
configured deployable. For a public OCI image, provide its SHA-256 digest,
evidence of an anonymous manifest digest check, and evidence that every
referenced config and layer blob was retrieved and verified. For a deployable
without a public OCI image, explicitly set `publicOci.required` to false and
supply a reason. Job success alone never verifies public registry availability.
Cache and registry evidence are supplied by the caller; this tool does not
perform the registry probes or independently verify deployment health. OCI and
Docker manifest indexes may provide each child under `publicOci.manifests`
with its digest, exact manifest text, HTTP status and anonymous-access flag.
Every referenced config and layer in `publicOci.blobs` needs its digest,
independently observed digest and size, HTTP status and anonymous-access flag.
The verifier hashes manifest bytes, checks descriptor sizes and the supplied
blob observations, and requires at least one runnable image. Digest-only records
without measured sizes fail closed and must be recaptured. Attestation
manifests are verified too; they do not count as a runnable image. It rejects
duplicate evidence, unsupported media types and excessive graph depth or size.

Captured inputs are historical snapshots. Before promoting a champion, check
the current target branch SHA and refresh the corresponding run, job, trigger,
cache, and registry evidence. A fixture or earlier successful run does not
establish that a later revision is current or working.

## Runtime SDK grounding

`vendor-runtime-grounding.mts` provides synchronous staging helpers that retain the runtime package’s original grounding implementation and declarations under its own `dist` directory. The helpers copy its MIT license, preserve shared module identity, declare the grounding implementation’s TypeScript dependency, and reject unexpected dependency or import changes. The WIT runtime primitives are exposed through the `@hobo/wit/runtime-primitives` type subpath.


## Pages release observation

The GitHub Pages provider reads the actual build state while the release
verification probe independently requires an authenticated, completed build
of the current Pages branch head. Queued or building releases remain pending
without requesting another build, and missing credentials fail verification.

If GitHub temporarily reports an older completed build after a new build is
requested, the provider can request another build on each reconciliation until
the latest-build endpoint catches up. The resolver does not currently persist a
pending request across controllers or restarts. Verification still requires a
completed build of the current branch head.

## CLI SDK bundling

The [`bundle-cli-sdk.mts`](bundle-cli-sdk.mts) prepares the CLI library
bundle with public SDK imports left external. It checks the pinned training source,
workspace import graph, computed imports, asset paths, and bundled MIT licenses before
recording source, output, and asset hashes in `BUNDLE-PROVENANCE.json`. Starter
`.gitignore` files are staged as `.gitignore.tpl` so npm retains them and the existing
renderer restores their intended names. [`bundle-cli-sdk.test.ts`](../test/bundle-cli-sdk.test.ts)
checks these guards and the packed asset inventory on Node 22. SDK staging invokes
the declaration and JavaScript helpers before packing. These helpers do not change
the protobuf, CUE, or PACT checks.

The CLI declaration helper copies the workspace dependency closure into an isolated
TypeScript project. It preserves public SDK alias imports, rejects undeclared external
imports and type references, compares exported names, and typechecks the result. Its
generator is pinned to 9.5.1 for Node 22 compatibility. `run-cli-sdk-bundle.mts` lists
`@hobo/identity` with the other vendored declaration packages because `@hobo/cd` exports
types that reference it. The staging runner records declaration source and license hashes
along with the final declaration hash, and the synchronous staging wrapper propagates
any failure before packaging.

SDK staging runs `verify-cli-sdk-artifacts.mts` before returning a manifest.
The verifier checks the exact SDK allowlist, source and license provenance,
every shipped CLI output, and a clean consumer installed from a loopback-only
registry. Failure removes the manifest so a previous or incomplete run cannot
be published. The offline acceptance disables third-party lifecycle scripts
while repacking test dependencies; it does not replace verification of a
normal lifecycle-enabled npm installation.

The OCI image input key includes SDK bundling helpers for the SDK image. The CLI
image key also depends on the SDK image key because CLI staging installs its npm
artifacts; the MCP image depends on the CLI image. This prevents an unchanged image
key from hiding a changed SDK artifact while leaving unrelated image keys independent.

## Composite action lint

`pnpm run actions:lint` walks `.github/actions/**/action.yml` and rejects
composite steps that set workflow-only fields such as `timeout-minutes` (use a
shell `timeout` instead) or `continue-on-error: ${{ ... }}`. Job timeout and
retry policy belong on the workflow job, not inside the composite. The composite
field walk parses `yaml` AST nodes in `scripts/lint-actions.ts` via
`lintCompositeStepFields` before matching unsupported step keys.
