# HoBo identity OCSF export contract POC

HOBO-282 pins the one-way SIEM projection for retained identity, token,
session, secret/config, and auth policy audit facts. The package is intentionally
a draft projection contract, not an identity issuer, token broker, session
store, or SIEM adapter.

This POC defines:

- OCSF `Authentication`, `Authorization`, and `Account Change` projections for
  the identity audit event family from `identity-event-contract`.
- A policy-decision route for auth `policy.Decided` facts using the existing
  policy audit export contract.
- Stable HoBo extension fields for event identity, tenant, sequence,
  correlation, causation, retention, subject, target, identity, token, and
  session metadata.
- Linked XAA credential-chain export so a user -> agent -> external app/provider
  grant lands in SIEM as connected authorization records.
- A one-way PII boundary: plaintext sensitive fields fail at the source contract,
  and protected subjects export only ciphertext refs plus hashed crypto-shred key
  refs.
- Batch ordering labels. Monotonic tenant streams are marked `preserved`; mixed or
  non-monotonic streams are explicitly marked `unordered`.

Scope intentionally stops at projection. It does not implement CloudEvents export
for non-security events, the CredentialAudit source projection, the crypto-shred
key hierarchy, or SIEM-side retention.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\identity-ocsf-export-contract test
```

The checks prove:

- every declared identity audit event fixture maps to a stable OCSF class,
- `policy.Decided` maps through the auth authorization projection,
- a full XAA grant/use/secret chain exports as linked authorization records,
- plaintext PII is rejected and encrypted protected-subject metadata does not
  leak key refs,
- mapping gaps fail loudly instead of silently dropping new event types,
- preserved and unordered export batches are labeled deterministically.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Identity Ocsf Export Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
