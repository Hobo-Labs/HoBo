# Operator Integration Ports Contract POC

Independent POC for HOBO-297. It pins the operator-facing `issue-tracker`
and `knowledge` ports named by ADR-0073 and Plan 40 without building a full
adapter matrix.

It proves:

- SRE Incident sync goes through a configured `issue-tracker` adapter and
  produces a durable Incident-to-ticket link.
- Postmortem knowledge publish goes through a configured `knowledge` adapter.
- Both writes are represented by `policy.Decided` plus `crew.ActionApplied`
  or `crew.ActionDenied`; no new event family is introduced.
- Adapter swaps are config-only through registered adapter ids.
- Failed ticket writes retain a pending Incident link and retry with the same
  idempotency key.
- Internal-only knowledge cannot publish to a public space when policy denies
  the write.

## Verification

Run the focused suite:

```powershell
npm.cmd --prefix src\draft\technical-proofs\operator-integration-ports-contract test
```

The root `npm.cmd test` also discovers this package's Node test suite.

## Scope Boundary

This package intentionally stops before concrete JIRA/GitHub Issues/Linear,
Confluence/Obsidian/Wiki implementations, generated adapters, credential
brokering, and full event-surface design. Those remain downstream adapter and
generation slices.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Operator Integration Ports Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
