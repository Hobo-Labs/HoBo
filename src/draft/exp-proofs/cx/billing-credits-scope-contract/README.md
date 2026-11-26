# Billing & Credits Scope Contract POC

Independent POC for HOBO-418. It records the M0 Billing & Credits scope and acceptance boundary
without implementing payment providers, tax calculation, usage metering, quota enforcement, invoice
rendering, or pricing pages.

## What This Proves

- `BILLING_CREDITS_SCOPE` is the accepted M0 record for `Billing & Credits`.
- Required personas, scope in/out, non-goals, and service/UX/security/support boundaries are explicit.
- Owning initiatives are mapped for Billing & Credits, Usage Metering, Entitlements & Plan Limits,
  Tax/Currency/Receipt Obligations, Support Workflow, Legal/Privacy, and Release Cutline.
- M1 evidence names the design records, contract tests, fixtures, legal review, and support handoff
  required before downstream implementation issues can start.
- `validateBillingCreditsScope()` rejects scope creep into live provider, tax, metering, entitlement,
  invoice, and pricing implementation work.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\billing-credits-scope-contract test
```

The root gate also covers the package:

```powershell
npm.cmd test
npm.cmd run docs:cli-lint
node scripts\validate-traceability.mjs
git diff origin/main...HEAD --check
```

## Architecture Evidence

- `architecture/` contains protobuf data shapes and CUE constraints for this contract.
- `architecture/pacts/billing_credits_scope_contract.pact.json` pins the boundary response.
- `ADR.md` names the parse boundary and event/CQRS proof vocabulary required by the repo
  architecture guard.
