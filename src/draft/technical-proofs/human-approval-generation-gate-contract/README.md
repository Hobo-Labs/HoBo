# Human Approval Generation Gate Contract

Independent POC for HOBO-360. It hardens the existing generation promotion
policy path by proving that high-risk/prod/high-trust generated artifacts cannot
certify without a meaningful human approval event.

## Contract

- `decideGenerationHumanApproval()` classifies the generation request using
  computed risk, environment, target trust/destructiveness, and mandatory
  policy packs.
- Prod/high-risk/high-trust/destructive or unknown-risk requests emit
  `policy.Decided`, `policy.ObligationCreated`, and
  `gen.ApprovalHookCreated`, but never `gen.Certified`.
- `resolveGenerationHumanApproval()` accepts only user-subject approvals with a
  non-empty human signal and evidence that provenance, conformance, and safety
  reports were shown.
- Mandatory deny-ceiling packs keep approval required even when lower-scope
  packs attempt auto-approval.
- `replayHumanApprovalGate()` rebuilds the event-sourced approval/denial state
  from zero.

## Scope Boundaries

This package does not implement the policy engine, dashboard or hook transport,
Registry publishing, SLSA signing, conformance execution, or the generation
runtime. It consumes their reports as immutable references.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\human-approval-generation-gate-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
node scripts\validate-sdk-contracts.ts
node scripts\validate-deployment-set-delta.ts
git diff origin/main...HEAD --check
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Human Approval Generation Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
