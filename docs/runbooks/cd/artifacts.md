---
type: Runbook
title: "HoBo.CD runbook: Artifact store"
description: "Stored artifacts, integrity and blob retention. Assembled from the Runbook section of packages/cd/src/artifacts/README.md."
tags: [hobo, cd, runbook, artifacts]
---

# HoBo.CD runbook: Artifact store

Stored artifacts, integrity and blob retention. This page is assembled from the **Runbook** section of `packages/cd/src/artifacts/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Code / metric | Action |
|---|---|---|
| Promotion blocked, verifier reports a corrupt blob | `artifact-corrupt`, `hobo.cd.artifact.corrupt` | The blob no longer hashes to its digest. Delete it (`store.delete(digest, "corrupt at rest")`) and re-put the original build output; a re-put of the true bytes also repairs in place. Investigate the disk or bucket (bit rot, manual edits, a proxy rewriting bodies). |
| `artifact-missing` for a `store` artifact | `artifact-missing` | The build never uploaded it or retention deleted it. Re-put the bytes, then re-record the Freight. Check `artifact.Deleted` on `cd-artifact-<digest>` for who deleted it and why. |
| Writes fail on the filesystem backend | `artifact-backend-unavailable` (`ENOSPC`, `EACCES`, …) | Free space or fix permissions on `<root>`; retry (idempotent by digest). Stray `<root>/tmp/*.partial` files are safe to delete when no CD process is writing. |
| S3 refuses requests | `artifact-backend-rejected` | The credential behind `credentialRef` lacks `s3:GetObject/PutObject/DeleteObject/ListBucket` or multipart permissions, or it expired. Rotate or widen it in the credential resolver; nothing secret is logged. |
| S3 outcome unknown (timeouts, resets) | `artifact-backend-unavailable` "outcome is unknown" | Retry: conditional create makes a repeated put safe. Abandoned multipart uploads are aborted by the store; add a bucket lifecycle rule (`AbortIncompleteMultipartUpload` after 1 day) as a backstop. |
| `artifact-credential-unavailable` | — | The resolver returned no `accessKeyId`/`secretAccessKey` for `credentialRef`. Fix the secret mapping. |
| `artifact-too-large` on S3 | — | Blobs over 256 MiB cannot cross the text `HttpTransport`. Use the filesystem backend for such artifacts or reference them in their registry. |
| Verifier: `artifact-registry-unavailable` / `-not-found` / `-malformed` | `hobo.cd.artifact.verify{outcome=…}` | Check reachability of the registry host from the CD service, the exact pinned version, and that a `repository_url` speaks the standard API. Private registries need the artifact mirrored into the HoBo store (`ecosystem: store`). |
| Verifier: `artifact-digest-mismatch` | — | The registry serves different bytes than the build attested. Do not promote. Rebuild the manifest from the published artifact or investigate the registry. |
| Verifier: `artifact-registry-digest-incomparable` | — | The registry publishes only sha512/sha1. Put the exact artifact bytes in the store so the verifier can hash them with the registry's algorithm. |
| Verifier: `artifact-coordinate-mutable` | — | Pin the coordinate: `…@sha256:<hex>` for OCI, `pkg:<type>/<name>@<version>` for packages. |
