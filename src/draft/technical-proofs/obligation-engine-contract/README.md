# Obligation Engine Contract

HOBO-141 proof package for the Plan 29 obligation engine boundary.

This package models obligations as replayable policy facts:

- `policy.ObligationCreated`
- `policy.ObligationEffectCompleted`
- `policy.ObligationSatisfied`
- `policy.ObligationEscalated`

The gate is derived only by replaying those events. A `policy.ObligationSatisfied`
fact is ignored unless the matching durable effect completion exists first, so a
forged satisfaction fact cannot unblock a gated action. Deadlines emit an
escalation fact and keep the gate blocked instead of silently satisfying or
lingering forever.

Included reference obligation kinds:

- `require-approval` -> `hobo.effect.human-approval/v1`
- `require-canary` -> `hobo.effect.rollout-canary/v1`
- `auto-revert` -> `hobo.effect.auto-revert-hook/v1`

Scope stays at the contract boundary. This package does not implement the
saga/effect runtime, Gatekeeper composition, or downstream residency,
guardrail, and cost-degradation obligations.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\obligation-engine-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Obligation Engine Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
