# Yard Receipt Consumption Contract

Source issue: HOBO-523.

This draft package proves the Yard consumes Meta-cloud Broker Resolution Receipts without becoming a
second hosted broker authority. It accepts only signed, current, compatible receipts and produces a
receipt-derived planning input. Missing, tampered, stale, incompatible, admin-mutated, or
Gatekeeper-rewritten handoffs fail closed.

## Proof Surface

- `consumeResolutionReceipt` parses a raw broker receipt into a derived Yard planning input.
- `rejectAdminReceiptMutation` documents the admin UI boundary: admin changes require a new receipt.
- `resolveGatekeeperHandoff` lets Gatekeeper block or add obligations without rewriting broker
  mappings.
- Architecture evidence lives in `ADR.md`, `architecture/*.proto`, `architecture/*.cue`,
  and `architecture/pacts/*.pact.json`.

## Acceptance Mapping

| HOBO-523 acceptance | Proof |
|---|---|
| Receipt fixture is accepted as broker authority input. | Focused test accepts `buildSignedReceiptFixture()` and emits a Yard planning input sourced from `resolution-receipt`. |
| Missing, tampered, stale, or incompatible receipt fixtures fail closed. | Focused test asserts stable refusal codes for missing, tampered, expired, and protocol-incompatible receipts. |
| Yard-local planning behavior is documented as receipt consumption, not broker authority. | `YardPlanningInput` records `planningAuthority=yard-control-plane`, `resolutionAuthority=meta-cloud-broker`, and `mayRecomputeBrokerMapping=false`. |

## Adversarial Coverage

- A missing receipt does not invoke a fallback broker resolver.
- Admin mutation of issued receipt contents is refused.
- Gatekeeper cannot rewrite resource mappings; it must block, add obligations, or require a new
  receipt/policy decision.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\yard-receipt-consumption-contract test
```
