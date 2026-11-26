# HOBO-48 auth.json Flow Contract Proof

This executable proof pins the M0 `auth.json` contract for HoBo Capability
Manifests from [Plan 6](../../ai-native-agent-auth.md#plan-06) and
[ADR-0009](../../adr/02-identity-security.md#adr-0009).

## Contract Surface

- Providers publish a versioned `auth.json` with issuer, flow list, scope model,
  resource indicators, token lifetime, and audit event facts.
- Audit event facts must include `token.Granted` and `token.Used`, matching the
  parser and schema so signed-token grants and uses stay observable.
- The broker selects flows in keyless-first order:
  `oidc-federation` > `oauth2-xaa` > `oauth2-obo` > `device-code` > `api-key`.
- `oauth2-xaa` is pinned to
  `draft-ietf-oauth-identity-assertion-authz-grant-04`, the active IETF
  Internet-Draft revision current on 2026-06-25.
- API-key-only manifests are explicit static-secret fallbacks, not silently
  equivalent to keyless auth.
- Manifest signatures bind the `auth.json` issuer to the trusted Registry entry.

## Proof Boundaries

The POC is structural. It validates contracts and fixture signatures but does
not crawl the Registry, perform OAuth/STS exchange, run live OIDC discovery, or
verify production cryptographic signatures.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-json-contract test
```

The checks live in
`src/draft/technical-proofs/hobo-auth-json-contract/test/auth-json-contract.test.ts`.
