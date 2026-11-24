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
`GITHUB_REPOSITORY` is set and matches the locator case-insensitively.
Hermetic checks live in
[`scripts/test/release-freight.test.ts`](../test/release-freight.test.ts).
Page and OCI realize behavior is documented in [`packages/hobo/CD.md`](../../packages/hobo/CD.md).

[`ensure-ci-worker-image.mts`](ensure-ci-worker-image.mts) materialize and digest
resolution contracts are exercised in
[`scripts/test/ensure-ci-worker-image.test.ts`](../test/ensure-ci-worker-image.test.ts).
Release `--resolve-digest` pins the worker only when `docker image inspect` lists
exactly one matching `RepoDigests` entry for `ghcr.io/<repo>/hobo-ci-worker@sha256:<64 lowercase hex>`.
