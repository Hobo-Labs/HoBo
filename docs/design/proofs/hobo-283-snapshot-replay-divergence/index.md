# HOBO-283 Snapshot Replay Divergence Proof

HOBO-283 proves the Plan 11 / Plan 32 / ADR-0050 / ADR-0051 hardening rule that a snapshot is only a cache. Current replay is the authority when snapshot metadata, fold output, upcaster chain, erasure epoch, or quarantine facts diverge.

## Scope

This proof lives in `src/draft/technical-proofs/snapshot-replay-divergence-contract`. It builds on the completed replay/live, upcaster, and snapshot lifecycle POCs without modifying them. It does not implement storage, Reactor delivery, poison-event incident handling, or crypto-shred key management.

## Acceptance Coverage

| Requirement | Executable proof |
| --- | --- |
| Snapshot-folded state equals from-zero replay across fuzzed `seq` boundaries. | `snapshot-folded state equals from-zero replay across fuzzed seq boundaries` |
| Snapshot stale with respect to fold/upcaster changes is invalidated and full replay wins. | `snapshot stale after a fold or upcaster change is invalidated and full replay wins` |
| Corrupt snapshot is ignored, not trusted. | `corrupt snapshot is ignored instead of trusted` |
| Pre-erasure snapshot is invalidated so shredded content cannot resurrect. | `pre-erasure snapshot is invalidated so shredded content cannot resurrect` |

## Adversarial Coverage

| Requirement | Executable proof |
| --- | --- |
| Impossible-future snapshot covering `seq` ahead of the stream is rejected. | `snapshot whose covering seq is ahead of the stream is rejected` |
| Fold-logic change without a snapshot version bump is caught before trust. | `fold logic change without a snapshot version bump is caught before trust` |
| Snapshot taken mid-quarantine reflects the same deterministic skip as replay. | `snapshot taken mid-quarantine reflects the same deterministic skip as replay` |

## Evidence

```powershell
npm.cmd --prefix src\draft\technical-proofs\snapshot-replay-divergence-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```
