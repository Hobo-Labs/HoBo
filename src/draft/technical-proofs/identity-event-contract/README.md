# Identity event contract POC

This draft pins the HOBO-66 M0 contract for `identity.*`, `token.*`, `session.*`,
`user.*`, `secret.*`, and `config.*` audit events plus the `CredentialAudit`
projection.

## Contract Surface

- All events use `schemaVersion: hobo.identity-events/v1`.
- Every audit event carries envelope linkage (`correlationId`, `causationId`) and
  `retention.neverCompact: true`.
- Token grants carry a reference (`tokenRef`) rather than a token value.
- Secret and config events carry references and sources, never plaintext values.
- `CredentialAudit` folds `token.Granted`, `token.Used`, `token.Revoked`, and
  `secret.Accessed` into the user -> agent -> target-app/provider chain.

## Proof Boundaries

This is a contract POC. It does not issue SVIDs, exchange tokens, verify JWKS,
store sessions, export OCSF, or implement the event-store backend.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\identity-event-contract test
```

The checks prove:

- every declared event type has a fixture and validates,
- every fixture round-trips,
- the CredentialAudit projection answers a user -> agent -> external-app XAA trace,
- `token.Used` without a preceding `token.Granted` is flagged as an anomaly,
- plaintext secret/config values fail at the event boundary,
- revocation remains an append-only fact separate from the original grant.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Identity Event Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
