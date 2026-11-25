# HOBO-295 Crypto-Shred Erasure Proof

HOBO-295 proves the Plan 32 / ADR-0032 / ADR-0051 hardening rule for right-to-erasure over an append-only log: erasure destroys forgetting keys and appends erasure facts; it never rewrites or deletes historical events.

## Scope

This proof lives in `src/draft/technical-proofs/crypto-shred-erasure-contract`. It models field-level encryption under per-subject keys, tenant-level key hierarchy erasure, notification recipient shredding, projection rebuild exclusion, write-side invariant linting, and pre-erasure snapshot invalidation. It does not implement the EventStore, production key management, tenant stream-key isolation, projection sink adapters, or identity/security-plane KMS wiring.

## Acceptance Coverage

| Requirement | Executable proof |
| --- | --- |
| Crypto-shred destroys a subject key, decrypted fields become tombstones, projections rebuild excluding the subject, and prior log events are not rewritten or removed. | `crypto-shred tombstones PII, rebuilds projections excluding the subject, and never rewrites prior log events` |
| Replay reproduces log structure identically while shredded fields read as post-erasure tombstones. | `replay preserves the same log structure digest while shredded fields decrypt to post-erasure tombstones` |
| A write-side aggregate invariant over a `forgettable` field fails lint/codegen. | `codegen lint rejects a write-side uniqueness invariant over a forgettable field` |
| A pre-erasure snapshot cannot resurrect shredded content. | `pre-erasure snapshot is invalidated so shredded content cannot resurrect` |

## Adversarial Coverage

| Requirement | Executable proof |
| --- | --- |
| Replay after erasure must not error on tombstones. | `replay after erasure is graceful and never errors on tombstones` |
| A uniqueness invariant over an erasable email is rejected at build. | `codegen lint rejects a write-side uniqueness invariant over a forgettable field` |
| Tenant erasure shreds only that tenant's key hierarchy. | `per-tenant erasure destroys only the target tenant key hierarchy` |
| Erasure by deleting log events is blocked. | `attempting to satisfy erasure by deleting log events is blocked` |

## Evidence

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
