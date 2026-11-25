# OCI Artifact Storage Contract

HOBO-354 proves the M1 registry storage seam can push and pull registry descriptors as OCI artifacts without introducing signing, discovery, version resolution, mirroring, or a real remote registry adapter.

## Scope

- `createOciArtifactStore()` creates an in-memory OCI-shaped content store.
- `push({ descriptor, artifact })` stores the registry descriptor and referenced artifact as digest-addressed blobs and returns the descriptor listing digest.
- `pull(digest)` returns the descriptor plus byte-identical artifact content.
- `resolve({ name, version })` returns the latest immutable listing digest for that coordinate.
- `events()` exposes `ProviderRegistered` and `CapabilityManifestUpdated`-class events emitted on first push.
- `catalog()` projects those events into a queryable read model.

## Guardrails

- Descriptor validation is delegated to the HOBO-331 registry descriptor contract.
- Artifact references remain digest-only and must match the supplied bytes.
- Re-publishing the same `name@version` with a different descriptor appends immutable history; old digests remain pullable.
- Identical content is idempotent and does not emit duplicate registry events.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\oci-artifact-storage-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Oci Artifact Storage Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
