# HoBo static-key escape hatch contract

Independent POC for HOBO-275. It hardens the last-resort static-secret branch
from [Plan 21](../../../../docs/design/authoring-resources-wiring.md#plan-21)
and [ADR-0023](../../../../docs/design/adr/02-identity-security.md#adr-0023)
without implementing the OIDC federation path, KMS adapter internals, or the
resolution ladder covered by HOBO-222.

## Contract surface

- Static keys are registered only as envelope references (`ciphertextRef`,
  `dekRef`, `kekRef`); plaintext material is rejected at registration.
- The default maximum TTL is `P7D`, and the hatch can only be configured down.
  Records past TTL fail closed with `StaticKeyExpiredError`.
- Rotation is enforced by `rotationDueAt`; overdue records fail closed even when
  callers request degraded best-effort.
- Every successful fetch requires explicit per-use opt-in and emits joined
  `token.Granted`, `token.Used`, and `secret.Accessed` audit events.
- Returned values are in-memory wrappers whose string and JSON forms are
  redacted.
- `assertStaticKeyNoPlaintextConformance(...)` checks Bindle, Camp persistence,
  audit events, logs, spans, and training trajectories for raw static key
  material.

## Proof boundaries

This package uses a fixture `envelopeStore.decrypt(...)` so the POC can prove
the contract without taking on provider KMS/Key Vault/HSM adapter internals. It
does not change HOBO-222's secretless resolution ladder; that package routes
non-federated providers to this bounded hatch.

## Executable checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\static-key-escape-hatch-contract test
```

The tests cover TTL max/fail-closed behavior, rotation fail-closed behavior,
per-fetch audit and opt-in, envelope-only persistence, and no plaintext in
events/logs/spans/training trajectories.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Static Key Escape Hatch Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
