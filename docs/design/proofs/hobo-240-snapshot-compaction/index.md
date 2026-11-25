# HOBO-240 Snapshot Compaction Proof

HOBO-240 proves the Plan 11 / ADR-0050 snapshot and domain-stream lifecycle policy as an independent draft contract under `src/draft/technical-proofs/snapshot-compaction-contract`.

## Scope

This proof models policy and lifecycle behavior above the EventStore primitive. It does not introduce a storage backend, app database migration snapshots, snapshot/replay divergence hardening, or erasure re-keying.

## Acceptance Coverage

| Requirement | Executable proof |
| --- | --- |
| Actor activates by replaying only the tail past its snapshot. | `actor activation replays only the tail past its snapshot` |
| Deleting snapshot yields identical state via full replay. | `deleting a snapshot yields identical state via full replay` |
| High-volume domain stream snapshot-and-truncated with audit marker and still rebuilds. | `high-volume domain stream snapshot-and-truncates with an audit marker and still rebuilds` |
| Attempt to compact `token.*` stream is refused. | `token, resource, and policy streams refuse compaction` |
| Runtime `run.*` archival after terminal state plus retention. | `terminal run streams archive only after the retention window` |

## Adversarial Coverage

| Requirement | Executable proof |
| --- | --- |
| Snapshot at `seq=N` plus tail from `N+1` equals from-zero replay. | `snapshot at seq N plus tail from N+1 equals from-zero replay without gaps or double-counts` |
| Corrupt snapshot detected and ignored, not trusted. | `corrupt snapshot is detected and ignored instead of trusted` |
| Truncation that would breach retention floor is blocked. | `truncation that would breach the retention floor is blocked` |

## Evidence

```powershell
npm.cmd --prefix src\draft\technical-proofs\snapshot-compaction-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff --check
```
