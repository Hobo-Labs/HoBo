# Showback Attribution Contract POC

Independent POC for HOBO-293. It pins the M2 showback attribution boundary
between `MeteringView` and run-inspector cost annotations without implementing
billing, invoicing, dashboard UI, shared-resource attribution correctness, or
the MeteringView fold itself.

## Contract Surface

- `createShowbackReport({ meteringView, costCatalog, displayNames })` consumes
  a seq-pinned `MeteringView` snapshot that retains source events.
- Usage costs roll up through `tenant -> Camp -> Bindle -> run`, with separate
  per-agent and per-team rows keyed by stable historical identifiers.
- Every row carries source event ids, cost by dimension, and reconciled
  presentation costs.
- `annotateRunInspector(report, inspector)` attaches cost evidence to existing
  run-inspector rows without defining a dashboard or billing surface. Duplicate
  run ids require full tenant/Camp/Bindle context or a `showbackRunId`.
- The supplied cost catalog must match the source `MeteringView` currency and
  recomputed total.

## Scope Boundaries

Included:

- Tenant, Camp, Bindle, run, agent, and team showback rows.
- Per-agent spend isolation without hiding tenant totals.
- Run-inspector cost annotations with MeteringView digest and source events.
- Ambiguous agent/team owners stay at the known hierarchy and record a rule.
- MeteringView attribution gaps become explicit showback rules rather than
  invented spend rows.
- Shared Bindle spend is deferred to the shared-resource attribution slice.
- Rounding reconciliation keeps emitted child rows summing to their row-set
  parent instead of absorbing unrelated unattributed spend.

Excluded:

- Billing, invoicing, chargeback, or payment flows.
- Dashboard UI and showback presentation screens.
- MeteringView projection implementation.
- Shared-resource attribution correctness across multiple Bindles.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\showback-attribution-contract test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Showback Attribution Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
