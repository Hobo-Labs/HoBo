# Registry Publish Flow Contract

This draft proof makes the HOBO-357 registry listing lifecycle executable without building a
production registry. It sits above HOBO-7's signed artifact boundary and below discovery/install
slices: an artifact can be published, but it is not discoverable as certified until conformance,
provenance, signature, and publisher checks all pass.

## Contract Surface

- `createRegistryPublishFlow()` accepts a registry descriptor, a signed artifact candidate,
  trust-boundary config, and per-interface conformance reports.
- `createInMemoryPublishArtifactStore()` records descriptor and signed-artifact refs in an
  OCI-shaped read model before any listing can be certified.
- A valid signed artifact emits `listing.Published`.
- Passing conformance for every exported interface emits `listing.Certified` and makes the listing
  visible in the catalog read model.
- Failed conformance leaves the listing published but unlisted.
- Publisher trust-domain mismatches reject before publication.
- Republishing the same `name@version` with different bytes appends immutable certified history.

## Boundary

This slice does not implement a production OCI adapter, signing primitives, install-time verification,
discovery ranking, yanking, trust-tier computation, curated-catalog approval, or real conformance
suite execution. It consumes those as already-signed artifacts and supplied report facts while
proving the publish flow hands them to an OCI-shaped store boundary.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\registry-publish-flow-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Registry Publish Flow Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
