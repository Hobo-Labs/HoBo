# DX SDK Resilience Scope Contract

Executable parent-scope contract for HOBO-514.

This draft package proves that the DX SDK resilience semantics epic is a concrete,
branch-sized blocker rather than a tracking-only issue. It records the accepted
M0-M4 child issue map, SDK-facing vocabulary, initiative links, and guardrails
that keep later retry, cancellation, deadline, lifecycle, supervision, cleanup,
and inspection work bounded to durable event facts.

## What It Proves

- HOBO-514 has concrete M0 acceptance and remains tied to the DX SDK Resilience
  Semantics project.
- The project remains linked to HoBo v1 Release Readiness and Developer
  Authoring & Agent Entry Points.
- Child issues HOBO-515 through HOBO-520 span M0 through M4 and each carries
  branch-sized scope, scope-out, acceptance, adversarial checks, target files,
  and verification commands.
- The design record is discoverable from `docs/design/README.md` and
  `docs/design/sdk-contracts.md`.
- Denial, cancellation, deadline, replay-derived inspection, and golden-IR
  parity failures cannot be treated as retryable or successful SDK behavior.
- Effect and XState stay reference inputs, not public dependencies.

## Architecture Guardrail Evidence

This package is a scope contract, not a runtime service, but it still carries
the repo-standard boundary evidence:

- PACT: `contracts/dx-sdk-resilience-scope.pact.json` records the read contract
  for consumers that need the accepted HOBO-514 matrix.
- Protobuf: `proto/dx_sdk_resilience_scope.proto` defines the scope record,
  child issue, adversarial rule, and phase data shapes.
- CUE: `cue/dx_sdk_resilience_scope.cue` constrains every protobuf type.
- Parse, don't validate: callers should parse raw issue text and project facts
  into parsed domain types (`Phase`, `ChildIssue`, `AdversarialRule`) before
  any helper or conformance claim can use them.
- Event architecture: the conceptual actor is the scope registrar. It accepts
  `RegisterScopeContract` and `RejectScopeCreep` commands, writes
  `scope.Accepted` and `scope.Rejected` events to an event-store fixture, derives
  a materialized view/projection for the child issue matrix, emits snapshots for
  stable PR evidence, and exposes the projection through a read store.

## Verification

Run the focused proof:

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-sdk-resilience-scope-contract test
```

Related records:

- [DX SDK resilience semantics](../../../../../docs/design/dx-sdk-resilience-semantics.md)
- [SDK contracts](../../../../../docs/design/sdk-contracts.md)
- [HOBO-514 proof record](../../../../../docs/design/proofs/hobo-514-dx-sdk-resilience/README.md)
