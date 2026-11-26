# Billing Launch Policy Contract POC

Independent POC for HOBO-489. It pins the M0 launch billing policy record without implementing
payment-provider integration, tax calculation, invoice rendering, legal terms, or money movement.

## Contract Surface

- `BILLING_LAUNCH_POLICY` is versioned as `hobo.billing-launch-policy/v1`.
- Required sections cover supported plans, prepaid credits, invoice timing, payment failure states,
  refund/credit correction, and v1 scope-out.
- Lifecycle states carry customer messaging, support action, audit evidence, and entitlement impact.
- Provider boundaries name checkout, webhook events, invoice sync, and money movement with mocked
  provider assumptions.
- Legal/privacy inputs must be blockers or explicit launch limitations.

## Scope Boundaries

Included:

- Deterministic M0 policy fixture and validator.
- Customer-visible state mapping.
- Provider-boundary and legal/privacy blocker records.
- Scope guards for tax-engine and live-provider implementation creep.

Excluded:

- Live checkout, webhook, invoice sync, charge, refund, payout, settlement, or tax calculation.
- Final legal terms, privacy text, refund-policy copy, or public compliance claims.
- MeteringView, showback, quota, or cost-safety implementation.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\billing-launch-policy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Billing Launch Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
