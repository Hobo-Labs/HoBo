# Go/No-Go Decision Record Contract

HOBO-483 defines the v1 go/no-go decision record and risk-acceptance workflow.

This POC records a machine-checkable contract in `src/go-no-go-decision-record.ts`:

- `template.requiredFields` pins gate, decision, approver role, evidence links, blocker deltas,
  accepted risks, and expiry or revisit date.
- `gateWorkflow` covers beta, release-candidate, and GA decisions with required evidence.
- `exceptionPolicy` requires owner, mitigation, launch note or follow-up, and revisit date before a
  non-blocking risk can ship.
- `scopeGuard` proves HOBO-483 defines the process only: it does not approve current risks, resolve
  launch blockers, or override CI, review, security, or contract gates.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\go-no-go-decision-record-contract test
```

The package is registered in `pnpm-lock.yaml` so `pnpm run install:check`
proves workspace dependency graph freshness before release-signoff changes merge.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the decision-record contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
