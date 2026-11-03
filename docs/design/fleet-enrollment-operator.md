# Fleet enrollment operator guide

This document summarizes operator-facing semantics from
[`fleet-enrollment-design.md`](./fleet-enrollment-design.md).

## Standalone vs shared fleet

- **Standalone SQLite box mode** remains a single admission authority. Multiple enrolled workers require the shared transactional PostgreSQL/SQLite strict store.
- **Shared fleet** uses durable `CiDemand`, `RunnerSlot`, and `ExecutionClaim` records with capacity groups and fenced effects.

## Execution classes

| Class | Meaning |
| --- | --- |
| **start-fenced** | At-most-once start authorization via pre-job hook + transactional bind |
| **external-assignment** | Admission intent only; no HoBo pre-start fence |

Trusted-local accepts private trusted jobs only. Isolated-required jobs must use an isolated profile. Do not mix trusted-local and isolated-required Offers behind one `runs-on: hobo` label.

## Device operations

- **Pause** — deny new admissions; clean unbound runners when possible.
- **Drain** — deny new admissions; wait for active work within bounds.
- **Revoke** — stop future credentials; retain uncertain claims.
- **Quarantine** — deny starts/effects until reconciliation completes.

## Restore and backup

After restore, mint a new controller incarnation, invalidate worker sessions and binding secrets, quarantine affected provider scopes, and reconcile before resuming admissions. Never bulk-expire claims and reissue.

## Residual limitations

External systems do not join HoBo database transactions. Restored databases cannot prove post-backup external activity. Nested builder usage inside workflows may bypass HoBo capacity accounting until composite Offers exist.
