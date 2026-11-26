# Meta-cloud Broker Rejection Matrix Contract

Source issue: HOBO-528.

This draft package proves the M3 adversarial rejection matrix for the Meta-cloud Broker without
building the hosted broker runtime, Yard planner, provider adapters, live remediation, or Admin
Console workflows.

## What It Proves

- Stale catalog, incompatible mapping, ambiguous mapping, missing mapping, and unsupported
  capability cases each have a deterministic fixture and expected rejection reason.
- Every case emits a structured signed `hobo.resolution-rejection/v1` object.
- No rejection emits a partial receipt, resource plan, optimistic Yard plan, or unsigned evidence.
- Rejection output is safe for support/debug use: replay inputs and evidence IDs are preserved, but
  raw secrets and customer payloads are excluded.
- Ambiguous best-effort selection, stale catalog optimism, provider-default fallback, and hidden
  Yard-local planning are all fail-closed.

## Acceptance Mapping

| HOBO-528 acceptance | Proof |
|---|---|
| Each adversarial case has a fixture and expected rejection reason. | `broker-rejection-matrix.test.ts` asserts all five fixtures and reason codes. |
| No rejection case emits a partial or unsigned receipt. | The same test asserts signed rejection evidence, `partialReceiptEmitted: false`, and no Yard planning. |
| Rejection output is safe for support/debug use without secrets. | The support/debug test injects unsafe material and asserts it is absent from serialized output. |

## Architecture Evidence

- `ARCHITECTURE.md` records parse boundaries, command/event/actor/projection vocabulary, and scope
  boundaries.
- `architecture/meta_cloud_broker_rejection_matrix.proto` pins the protobuf data contract.
- `architecture/meta_cloud_broker_rejection_matrix.cue` pins CUE constraints for the protobuf types.
- `architecture/pacts/meta_cloud_broker_rejection_matrix.pact.json` records consumer/provider
  expectations for structured rejection outcomes.

## Verification

```powershell
pnpm.cmd --prefix src\draft\meta-cloud-broker-rejection-matrix-contract test
```

## Scope Boundaries

This package does not implement provider-specific live remediation, Admin Console workflows, hosted
broker service persistence, provider adapters, Yard planner or Matching behavior, Gatekeeper policy
changes, or release-facing broker claims. It is a branch-proof contract that later broker runtime
work must honor.
