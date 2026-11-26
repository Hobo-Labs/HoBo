# HoBo policy audit export contract POC

HOBO-175 pins the policy audit event family and the first OCSF export seam for
policy decisions. The package is intentionally a draft contract, not the policy
engine.

This POC defines:

- The retained org-scoped policy audit event family:
  `policy.Decided`, `policy.ViolationDetected`, `policy.WaiverRequested`,
  `policy.WaiverApproved`, and obligation lifecycle facts.
- Required policy-pack version evidence on every event, so "why was this
  allowed or blocked, and under which pack version?" is reconstructable.
- OCSF audit projection for policy decisions and violations as
  Authorization-like events, and waiver/obligation lifecycle facts as
  Configuration Change-like events.
- A one-way PII guard: plaintext PII keys fail validation; exports carry only
  ciphertext references or crypto-shredded redaction markers.
- Append-only stream validation using retained audit metadata and a content hash
  chain.

Scope intentionally stops at the audit contract. It does not implement the
policy engine, CloudEvents/OTLP envelopes, or the OCSF attestation export for
compliance/model-card evidence.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Audit Export Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
