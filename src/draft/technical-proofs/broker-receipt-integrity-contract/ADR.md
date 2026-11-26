# Broker Receipt Integrity Contract - Architecture Evidence

HOBO-529 proves the security hardening boundary for Meta-cloud Broker Resolution Receipts. This
package does not implement production key management, hosted broker operations, live persistence,
provider adapters, Yard planning, or Gatekeeper apply-time policy. It proves the receipt integrity
contract that later runtime and operations issues must honor.

## Schema Sources Of Truth

- **Protobuf** - `architecture/broker_receipt_integrity.proto` defines the receipt, expected
  consumption context, support-safe debug evidence, and refusal-code contract.
- **CUE** - `architecture/broker_receipt_integrity.cue` constrains every protobuf type, including
  digest formats, Ed25519 signature envelope fields, schema floors, and refusal-code values.
- **PACT** - `architecture/pacts/broker_receipt_integrity.pact.json` pins the boundary between the
  Meta-cloud Broker receipt authority and the Yard receipt verifier.

## Parse, Don't Validate

Raw receipt JSON crosses one verifier boundary and becomes either an accepted receipt evidence
record or a structured rejection. Those are the parsed derived domain types for this package. Core
consumers should accept only those derived results, not raw receipt DTOs plus repeated boolean
checks. Invalid, stale, downgraded, replayed, or reused receipts are unrepresentable past this
parser boundary.

## Event Architecture

- **Command** - `VerifyResolutionReceipt` asks the Yard receipt verifier to check broker evidence
  for a specific tenant, environment, manifest digest, and broker snapshot digest.
- **Events** - valid receipts emit `ReceiptIntegrityAccepted`; invalid receipts emit
  `ReceiptIntegrityRejected` with a stable support-safe reason code.
- **Actor** - the receipt-integrity actor is the single writer for per-receipt consumption status so
  replay checks are not race-prone.
- **Event store** - receipt acceptance and rejection events append to the Yard control-plane event
  store.
- **Projection** - support/debug read models expose receipt id, tenant id, environment id, manifest
  digest, broker snapshot digest, and refusal code without key material or signatures.
- **Snapshot** - snapshots bound replay cost for receipt consumption histories while preserving the
  per-receipt replay ledger.
- **Read store** - support/operator reads expose customer-safe rejection evidence only.

Gatekeeper remains downstream of receipt verification. It can block or require obligations at apply
time, but broker receipt integrity cannot encode a Gatekeeper outcome as a pre-receipt authority
shortcut.
