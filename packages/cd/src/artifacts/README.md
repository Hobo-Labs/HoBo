# `@hobo/cd/artifacts`: artifact store and registry-digest verifier

The content-addressed artifact store (C14) and the verifier the Freight ledger
calls before it records a manifest (D3). This folder is work package WP3 of
[plan 0024](../../../../docs/plans/0024-hobo-cd-swarm-instruction.md); the
provenance half lives in [`../provenance`](../provenance/README.md).

| Export | What it does |
|---|---|
| `createArtifactStore(config, d)` | The frozen `ArtifactStore` port over `filesystem`, `s3-compatible` or `memory`. `d` may also carry a `telemetry: TelemetrySink`. |
| `createArtifactVerifier(d)` | The frozen `ArtifactVerifier` port: every manifest artifact is checked at its coordinate. `d` may also carry `telemetry`. |
| `ARTIFACT_REASON`, `ArtifactStoreError` | Refusal/error codes (wire contract) and the typed error the store throws. |
| `ARTIFACT_METRICS` | Metric names emitted through `TelemetrySink`. |
| `REGISTRY_ECOSYSTEMS`, `DEFAULT_REGISTRIES` | The registered ecosystems and their default endpoints. |
| `signS3Request`, `ARTIFACT_MULTIPART_THRESHOLD_BYTES`, `ARTIFACT_S3_MAX_BLOB_BYTES` | S3 SigV4 signing (pinned by the AWS vectors) and the S3 limits. |
| `parsePurl`, `parseOciReference`, `parseDigest` | Total parsers used at the verifier boundary. |

## Design

- **Parse, don't validate.** Every untrusted input becomes a parsed type
  before it is used: digests become the `Digest` brand through `parseDigest`,
  coordinates become `Purl` / `OciReference` derived types (or nothing),
  store configs pass `parseS3Config`, and registry responses are read through
  JSON guards into `RegistryDigest` values. Records are the generated
  `cd_pb.ts` types; `data-models/artifacts.cue` carries the same constraints.
- **Commands and events.** `put` and `delete` are the commands; each folds
  the per-digest stream `cd-artifact-<digest>` (the actor's whole state) and
  appends at most one event with expected-seq CAS. The `DurableEventStore` is
  the only event store. No projection, materialized view or read store is
  kept: presence is the backend's, and `history` reads the stream directly; no
  snapshot is needed because a digest stream holds a handful of facts.
- **Content addressing.** The store computes the sha256 digest itself; a
  caller never names the digest of bytes it puts. The `ArtifactRef` it returns
  has coordinate `store://<backend>/sha256:<hex>` and ecosystem `store`.
- **Verify on read.** Every `get` re-hashes the bytes. A mismatch throws
  `ArtifactStoreError` with code `artifact-corrupt` and emits
  `hobo.cd.artifact.corrupt`. It is never reported as "absent" and the bad
  bytes are never returned. The next `put` of the true bytes repairs the blob.
- **Atomic writes.**
  - Filesystem: write to `<root>/tmp/<hex>.<pid>.<n>.partial`, `fsync`,
    `rename` to `<root>/blobs/sha256/<hh>/<hex>`, `fsync` the directory. A
    failed write removes its temp file; temp files are never listed or read.
  - S3-compatible: conditional create (`If-None-Match: *`). Above 64 MiB the
    upload is multipart and is aborted on any failure; S3 exposes nothing
    before `CompleteMultipartUpload`, which is itself conditional.
- **S3 over the text transport.** `@hobo/core` `HttpTransport` bodies are
  strings, so objects are stored base64-encoded with
  `x-amz-meta-hobo-encoding: base64` and decoded on read; the digest is always
  over the decoded bytes. This caps an S3 blob at 256 MiB
  (`artifact-too-large` above it). Requests are path-style and signed with
  SigV4 from `@hobo/core/aws-sigv4`; credentials are resolved per call from
  `credentialRef` with scope `artifact-store:s3:<bucket>` and exist only in the
  signing call.
- **Journal.** `artifact.Stored` and `artifact.Deleted` go to
  `cd-artifact-<digest>` with expected-seq CAS and idempotency keys, once per
  transition: re-putting a stored blob records nothing; a second delete
  records nothing. `delete` needs a reason (the retention sweep passes one).
  Golden v1 bodies live in `test/artifacts/golden-journal.test.ts`.
- **Verifier.** Fail-closed per artifact; the outcome is ok only when every
  artifact verified, and every failure is reported (one reason per artifact,
  `subject` = artifact name).

  | Ecosystem | Registry digest at the coordinate |
  |---|---|
  | `store` (or none) | the store's verified copy (and size, when declared) |
  | `oci` | manifest fetched by digest (`host/repo[:tag]@sha256:…`), hashed, and `Docker-Content-Digest` cross-checked; anonymous bearer-token flow |
  | `npm` | `dist.integrity` (sha256 directly, sha512 via the stored copy), `dist.shasum` fallback |
  | `nuget` | registration leaf → catalog `packageHash` (SHA512 via the stored copy); the catalog must be on the registration host |
  | `pypi` | `urls[].digests.sha256` of the named file (`file_name` qualifier or artifact name) |
  | `maven` | `.sha256`, else `.sha1` via the stored copy |
  | `cargo` | sparse index `cksum` for the pinned version |
  | `rubygems` | `sha` of the pinned version (`platform` qualifier honoured) |
  | `git`, `http` | only through a stored copy, else `artifact-unverifiable` |

  Coordinates must pin a version (or an OCI digest): a tag or a version-less
  purl is `artifact-coordinate-mutable`. A `repository_url` qualifier must be
  https without credentials. An unknown ecosystem is
  `artifact-ecosystem-unsupported` and is never consulted.
- **Telemetry.** `hobo.cd.artifact.stored`, `.stored.bytes`, `.deleted`,
  `.corrupt` (attribute `backend`) and `hobo.cd.artifact.verify` (attributes
  `ecosystem`, `outcome`). A failing sink never fails a command.
- **Contracts.** `contracts/artifacts.pact.json` (S3 object store) and
  `contracts/artifacts.registries.pact.json` (registries), verified by
  `contracts/artifacts.consumer.test.ts`; `data-models/artifacts.cue`, vetted
  against real records by `test/artifacts/cue.test.ts`.

## Runbook

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
