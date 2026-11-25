# Entitlement Abuse Rate-Limit Policy Contract

Executable M0 policy contract for HOBO-491.

This draft package records the accepted entitlement abuse, rate-limit, and fraud-response policy
shape before M1 design or implementation work fans out. It is intentionally not a fraud scoring
engine, runtime rate limiter, billing integration, support queue, or production suspension system.

## What It Proves

- Entitlement limit types, rate-limit behavior, grace states, suspension states, appeals, and
  support overrides are explicit.
- Abuse and suspected-fraud response rows carry audit evidence, customer communication, and recovery
  paths.
- Billing, tenant quota, security verification, and support boundaries route to owning initiatives.
- M1-M4 follow-up work remains gated until the HOBO-491 policy is accepted.
- Scope creep into fraud scoring engine selection, runtime enforcement, billing provider work, or
  support automation is rejected.

## Verification

Run the focused proof:

```powershell
corepack pnpm --prefix src\draft\technical-proofs\entitlement-abuse-rate-limit-policy-contract test
```

The proof is also referenced by the design record:

- [Entitlements & Plan Limits design record](../../../../docs/design/entitlements-plan-limits.md)
- [HOBO-491 proof record](../../../../docs/design/proofs/hobo-491-entitlement-abuse-rate-limit-policy/README.md)

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the policy contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
