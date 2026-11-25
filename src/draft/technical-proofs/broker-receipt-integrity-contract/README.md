# Broker Receipt Integrity Contract

Source issue: HOBO-529.

This draft package proves Meta-cloud Broker Resolution Receipt integrity and reuse refusal before
beta claims. It accepts only current Ed25519-signed receipt fixtures for the expected tenant,
environment, manifest digest, and broker snapshot digest, and it returns customer-safe rejection
evidence for tamper, replay, downgrade, expiration, and cross-boundary reuse cases.

## Proof Surface

- `buildSignedResolutionReceiptFixture` emits deterministic fixture receipts signed by a test
  Ed25519 key pair.
- `verifyResolutionReceipt` parses a raw receipt at the broker/Yard handoff boundary and returns
  either an accepted receipt-derived evidence record or a structured, support-safe rejection.
- Architecture evidence lives in `ADR.md`, `architecture/*.proto`,
  `architecture/*.cue`, and `architecture/pacts/*.pact.json`.

## Acceptance Mapping

| HOBO-529 acceptance | Proof |
|---|---|
| Tampered, replayed, downgraded, expired, and cross-environment receipts are rejected. | Focused tests assert precise refusal codes for tamper, replay, downgrade, expiration, tenant, environment, broker snapshot, and manifest digest reuse. |
| Valid receipt fixtures remain accepted. | The valid fixture test accepts a signed receipt and emits support-safe debug evidence. |
| Failure reasons are precise and do not leak secrets. | Rejection results expose stable codes plus safe receipt metadata only; tests assert no key material, signature, or hidden handoff object leaks. |

## Adversarial Coverage

- Receipt reuse across tenant, environment, broker snapshot, or manifest digest is refused.
- Rejection results never emit a partial or unsigned receipt.
- Gatekeeper remains an apply-time policy boundary and cannot be embedded into broker receipt
  integrity as a pre-receipt decision.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\broker-receipt-integrity-contract test
```
