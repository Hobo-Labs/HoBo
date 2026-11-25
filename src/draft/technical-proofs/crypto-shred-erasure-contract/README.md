# Crypto-Shred Erasure Contract

Independent proof package for HOBO-295. It models the append-only right-to-erasure contract from Plan 32 / ADR-0032 / ADR-0051 without implementing key-management infrastructure.

## Contract Surface

- `createKeyring(...)` provisions tenant and subject forgetting keys for test fixtures.
- `appendRegisteredCustomer(...)` and `appendNotificationSent(...)` write encrypted PII references to an append-only log.
- `cryptoShredSubject(...)` records `erasure.Requested` / `erasure.Completed`, destroys the subject key, and leaves prior events untouched.
- `cryptoShredTenant(...)` records `tenant.Erased` and destroys only that tenant's key hierarchy.
- `rebuildProjection(...)` replays the log structure deterministically, decrypts shredded fields as tombstones, and excludes erased subjects from projections.
- `assertNoForgettableWriteInvariants(...)` is the codegen/lint guard that rejects write-side aggregate invariants over `forgettable` fields.
- `createSnapshot(...)` / `activateSnapshot(...)` prove pre-erasure snapshots are invalidated when the erasure epoch changes.

## Scope Boundaries

This package does not implement the EventStore, real KMS/HSM integration, tenant stream-key isolation, snapshot storage, projection sinks, or policy-plane incident workflow. It proves the branch-local contract those systems must preserve.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\crypto-shred-erasure-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Crypto Shred Erasure Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
