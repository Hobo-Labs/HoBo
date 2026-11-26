# Launch Performance Capacity Envelope Contract POC

Independent POC for HOBO-502. It pins the M0 launch performance, cost, and capacity envelope
without executing production load tests, tuning capacity, provisioning infrastructure, or making
customer production-capacity claims.

## Contract Surface

- `LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE` is versioned as
  `hobo.launch-performance-capacity-envelope/v1`.
- Required sections cover target workflows, beta load assumptions, measurable thresholds,
  capacity assumptions, deterministic load-test fixture shape, and non-goals.
- Thresholds map measurable beta/GA targets to support routing and release-note handling.
- Cost guardrails are explicitly owned by Usage Metering, Billing & Credits, and Entitlements &
  Plan Limits.
- Fixture rows must be deterministic and must not execute against production.

## Scope Boundaries

Included:

- Deterministic M0 envelope fixture and validator.
- Workflow, load, threshold, capacity, fixture, and cost-guardrail records.
- Scope guards against production load execution and hidden billing or entitlement implementation.

Excluded:

- Production load-test execution, live customer traffic, or customer production sizing claims.
- Autoscaling, capacity tuning, provisioning, or load-test infrastructure.
- Usage billing, invoices, payment collection, tax, refunds, rate limits, or entitlements.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\launch-performance-capacity-envelope-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Launch Performance Capacity Envelope Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
