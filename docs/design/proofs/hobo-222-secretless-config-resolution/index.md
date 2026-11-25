# HOBO-222 Secretless Config Resolution Proof

This executable proof backs [Plan 21](../../authoring-resources-wiring.md#plan-21),
[ADR-0027](../../adr/02-identity-security.md#adr-0027), and the
[secrets management](../../security-networking.md#secrets-management) summary.

## Contract Surface

- The proof package is
  [`src/draft/technical-proofs/secretless-config-resolution-contract`](../../../../src/draft/technical-proofs/secretless-config-resolution-contract).
- Bound-resource config resolves to a brokered provider token without reading a
  secret.
- Federated `secretRef` resolves through the Camp's `secrets` port adapter at
  use-time and records `secret.Accessed` joined to `token.Used`.
- Non-secret config resolves from the Camp config surface and records
  `config.Resolved`.
- `SecretValue` keeps the provider value in memory and serializes as redacted.
- No-plaintext conformance scans Bindle, Camp, event, log, and span surfaces.
- Providers without federation route to the bounded static-secret hatch without
  reading or persisting plaintext.
- The Camp-selected `secrets` adapter can change without editing the app
  declaration.

## Proof Boundaries

This proof consumes the HOBO-110 OIDC-federation token exchange and does not
reimplement provider STS. It also excludes typed-schema codegen to `ctx.config`,
static-secret hatch hardening, and IaC-state secret-sink reference migration.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\secretless-config-resolution-contract test
```

The tests cover the HOBO-222 acceptance and adversarial cases: ladder paths
(a)-(c), no plaintext in persisted surfaces, event-log leak detection, fallback
to the static hatch when federation is missing, and adapter swapping without app
edits.
