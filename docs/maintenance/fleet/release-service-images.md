---
type: Runbook
title: "Fleet runbook: release service images"
description: "How the HoBo Fleet authority, witness and peer-to-peer relay images are built, published as release Freight, attested with provenance and a bill of materials, verified and rolled back."
tags: [hobo, fleet, runbook, maintenance, release, supply-chain]
---

# Release service images

Three images run the server side of a fleet: `hobo-fleet-authority`,
`hobo-fleet-witness` and `hobo-fleet-relay`. Their Dockerfiles are under
[`deploy/release-images/`](../../../deploy/release-images/); the publishing
script is `scripts/ci/push-release-service-image.mts`
([`scripts/ci/README.md`](../../../scripts/ci/README.md), "Fleet service
release images"). `scripts/test/fleet-release-workflow.test.ts` holds the
workflow to this description.

## How a release ships them

1. The `release-service-images` job of `.github/workflows/release-hobo.yml`
   runs one leg per image (`max-parallel: 1`, `fail-fast: false`) on the
   full release train only. An `sdk-v` or `cli-v` tag ships none of them:
   the digest list is written empty and nothing is built.
2. The authority and the witness are staged from `@hobo/fleet-authority`
   with `pnpm deploy` and `bin/<name>` wrappers. The relay has an empty build
   context; its Dockerfile fetches the pinned, checksum-verified
   `iroh-relay` itself. Every Dockerfile takes `HOBO_TOOLCHAIN_IMAGE`,
   `HOBO_RELEASE_VERSION` and `HOBO_RELEASE_REVISION`.
3. Each image is exported as an OCI image layout and promoted as release
   Freight through `hobo deploy`, like the train's other images. The
   realizer is the only thing that pushes; the job never runs `docker push`.
4. The published `ghcr.io/…@sha256:…` digest is attested with build
   provenance and a CycloneDX bill of materials by
   `.github/actions/release-oci-attest`.
5. The Freight journal is uploaded as `hobo-service-freight-<id>`, separate
   from the train's `hobo-release-freight-oci-*` journals, so the release tag
   and the GitHub Release do not count these images as part of the train.

## Before deploying a release

1. Take the digests from the job's output, not a tag.
2. Verify each digest's provenance and bill of materials with
   `gh attestation verify oci://ghcr.io/<owner>/<image>@sha256:<digest>
   --repo <owner>/<repo>`.
3. Set `HOBO_FLEET_VERSION` (and `HOBO_FLEET_IMAGE_PREFIX`) for the Compose
   files, or the image references in `deploy/fleet/kubernetes/`, to the
   verified digests, and upgrade as [install and
   upgrade](./install-and-upgrade.md) describes.

## A leg failed

Legs are independent: a failed image does not stop the others. Re-run the
failed leg of the same workflow run; promotion is by digest, so a re-run
publishes the same content or a new digest, never a moved tag. Do not build
and push an image by hand: it would carry no attestation, and the deployment
should refuse an unverified digest.

## Roll back

Take a [backup](./backup-and-restore-drill.md) first, then deploy the
previous release's verified digests: the authority, then the witness; the
relay at any time. Whether an older authority reads every event a newer one
appended is not tested, so if the older one refuses its journal, restore the
backup into a fresh deployment of the older release.

## Status

Built and tested in the repository. Not proven by a real release until the
first release run's job is linked here.
