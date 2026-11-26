# Generation Promotion Policy Gate POC

Independent POC for HOBO-333. It wires the generation-pipeline certify step to
the existing policy-plane decision shape instead of creating a second trust path.

## Contract

- `buildPromotionPolicyRequest()` lowers a generation candidate to a
  `hobo.policy-ir/v1` request with `action: "gen.certify"` and `phase: "promote"`.
- `createGenerationPromotionGate()` evaluates that request through a
  policy-engine adapter and records `policy.Decided`.
- Low-risk, non-prod candidates with green conformance and eval evidence emit
  `gen.Certified`.
- Prod, high-risk, high-trust, or unknown-risk candidates emit a `createHook`
  approval path and cannot certify until `gen.ApprovalHookResolved`.
- `rebuildPromotionGateRun()` folds the event stream from zero so the decision is
  replayable.

## Scope Boundaries

This POC does not implement the policy engine, dashboard/Slack hook delivery,
Registry publishing, SLSA signing, conformance suites, or validation stage. It
only proves the generation-specific gate adapter and event contract.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-promotion-policy-gate-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Promotion Policy Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
