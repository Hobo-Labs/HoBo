# Crew Event Contract POC

Independent proof for `HOBO-254`: the `crew.*` roster-level event family and shared operator principal descriptor.

## Scope

- Operator principals carry `{ name, svid, perAgentPolicy, enginePort, disabled }`.
- `crew.AgentDispatched`, `crew.ActionProposed`, `crew.ActionApplied`, `crew.ActionDenied`, and `crew.HandoffRequested` share one envelope shape with principal, correlation, and causation metadata.
- `policy.Decided` remains the reused policy seam; this POC only validates references to it.
- From-zero replay folds proposals, applications, denials, and handoffs into an auditable summary.

## Guards

- `crew.ActionApplied` and `crew.ActionDenied` require a `policy.Decided` reference.
- Replay rejects applied/denied facts that do not follow both a proposal and a policy decision.
- Replay rejects action resolution that crosses proposal `correlationId` boundaries or applies a denied/still-gated decision.
- Handoffs for the same `correlationId` must be causally chained, preventing two operators from racing the same incident without serialization.

## Run

```powershell
npm.cmd --prefix src\draft\technical-proofs\crew-event-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Crew Event Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
