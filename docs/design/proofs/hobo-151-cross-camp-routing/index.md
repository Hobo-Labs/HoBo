# HOBO-151 Cross-Camp Routing Policy Proof

This branch proves the cross-Camp DNS routing-policy contract from
`security-networking.md#plan-12` and ADR-0035.

## Acceptance Mapping

| Issue acceptance | Executable proof |
|---|---|
| Each policy programs the expected record set. | `src/draft/technical-proofs/cross-camp-routing-policy-contract/test/routing-policy.test.ts` asserts weighted, failover, latency, and geo record outputs. |
| Failover flips only after sustained active-target failure and only to a cleared target. | The failover tests require two consecutive failures and reject an unvalidated target. |
| Every flip emits `domain.RoutingChanged` with target and reason. | The tests assert selected Camps and human/audit-readable reasons. |
| Latency/geo pick the nearest healthy Camp. | Latency and geo tests exclude unhealthy Camps and pick the nearest healthy validated target. |
| DNS promotion stays behind validation-cleared targets. | Weighted and failover negative tests refuse unvalidated Camps without producing a record. |

## Scope Boundary

The POC intentionally consumes, rather than rebuilds, these prior seams:

- `hobo:dns` policy shape and shadow/live-zone separation from HOBO-101.
- domain validation from HOBO-142 / HOBO-113.
- staged/canary cutover and rollback from HOBO-148.

Cost routing, per-route single-writer eligibility, and Junction federation stay
out of this issue.
