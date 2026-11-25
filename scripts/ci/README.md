# scripts/ci

Scripts the GitHub workflows under `.github/workflows/` run. Each script's
header comment is its reference; this page collects the ones whose contract
spans several files.

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
`blocked (none)`. The `Record, promote and publish` step of `release-hobo.yml`
passes `GITHUB_TOKEN: ${{ github.token }}` so Pages realize uses the job-scoped
token with `contents: write`, not `secrets.GITHUB_TOKEN`. The `release-contract` job builds those workspace
packages (`RELEASE_CONTRACT_SCRIPT_BUILD_FILTERS` in
`scripts/lib/release-contract-script-build.mts`) before its vitest list so sparse
checkouts have `dist/` without pulling `@hobo/cd` source into the scripts lane.
When `scripts/ci/attested-jobs.json` changes, bump `SHADOW_PLAN_BLOB` in
`attestation.mts` to the git blob id
`scripts/test/attested-jobs.test.ts` asserts.
Hermetic checks live in
[`scripts/test/release-freight.test.ts`](../test/release-freight.test.ts).
Page and OCI realize behavior is documented in [`packages/hobo/CD.md`](../../packages/hobo/CD.md).

Pages release sparse checkout lists directory cones only in `RELEASE_PAGES_SPARSE_PATHS`
(`examples` covers `examples/browser-runtime/wit/station.wit`); `hobo-checkout` routes
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
