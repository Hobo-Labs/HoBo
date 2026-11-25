# HOBO-334 Reliability SLA Rollup Proof

This proof records the branch evidence for ratifying reliability SLA targets and
shipping the status-page / operations-dashboard rollup data contract.

## Acceptance Evidence

- `src/draft/technical-proofs/reliability-sla-rollup-contract` encodes the built-in reliability
  targets as SLO-engine assertions and marks each target `ratified` or
  `provisional`.
- The RTO drill checker accepts a production-scale event-log replay under 15
  minutes and rejects CI-scale false passes as provisional.
- The rollup projection shows observed SLO values next to AvailabilityView
  estimates per environment.
- Target breaches and tenant-scoped subcomponent burns surface as incidents, so
  the status page cannot render green while a subcomponent burns.
- Stale SLI reads render `delayed/unknown` rather than a confident green status.
- Rollup state rebuilds deterministically from events only, and status-page
  publication has a reversible `statuspage.Unpublished` mutation.

## Scope Boundary

This proof intentionally does not implement the SLO computation engine,
AvailabilityView graph algorithm, dashboard UI, public status-page product,
alert routing, or cost-induced degradation handling. It consumes those as
contract inputs and proves the HOBO-334 rollup/applier boundary.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\reliability-sla-rollup-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
