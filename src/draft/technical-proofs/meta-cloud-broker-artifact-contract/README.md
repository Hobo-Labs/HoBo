# Meta-cloud Broker Artifact Contract

Independent POC for HOBO-522.

This package pins the M1 artifact schemas and validation proof for the Meta-cloud Broker. It
extends the HOBO-521 M0 vocabulary into executable fixtures for:

- Contract Manifest
- Broker Environment
- Mapping Contract
- Broker Catalog Snapshot
- Resolution Receipt
- Resolution Rejection

## What It Proves

- Artifact schemas and golden fixtures exist for all six broker artifacts.
- Every artifact names owner, semantic version, source issue, referenced design records, proof mode,
  and a signature digest.
- Valid manifest/environment/mapping/catalog inputs deterministically produce either a Resolution
  Receipt or a structured Resolution Rejection.
- Unsigned, unversioned, ambiguous, or ownerless artifacts fail closed.
- Hosted broker policy artifacts cannot masquerade as Gatekeeper policy.
- The proof stays out of hosted broker runtime, Yard planner, provider adapter, admin UI, and
  Gatekeeper implementation scope.

## Architecture Evidence

- `schema/meta-cloud-broker-artifacts.v1.schema.json` pins the artifact envelope.
- `architecture/meta_cloud_broker_artifact_contract.proto` defines records and messages.
- `architecture/meta_cloud_broker_artifact_contract.cue` attaches constraints to every protobuf
  type.
- Protobuf, CUE, JSON schema, and TypeScript declarations all use the same `source.issue` plus
  `source.refs` provenance shape so contract evidence cannot drift across views.
- `architecture/pacts/meta_cloud_broker_artifact_contract.pact.json` records the package boundary.
- `ARCHITECTURE.md` documents parse-don't-validate and event architecture vocabulary.

## Verification

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\meta-cloud-broker-artifact-contract test
```
