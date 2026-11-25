# HoBo auth.json Flow Contract POC

This draft pins the HOBO-48 contract for the Capability Manifest `auth.json`
surface from [Plan 6](../../../../docs/design/ai-native-agent-auth.md#plan-06)
and [ADR-0009](../../../../docs/design/adr/02-identity-security.md#adr-0009).

## Contract Surface

- `auth.json` declares a provider issuer, supported auth flows, token lifetime,
  resource indicators, and audit events.
- `audit.events` must include `token.Granted` and `token.Used` so broker-issued
  credentials are traceable at grant and use time.
- Flow selection is deterministic and keyless-first:
  `oidc-federation` > `oauth2-xaa` > `oauth2-obo` > `device-code` > `api-key`.
- `oauth2-xaa` uses the pinned ID-JAG draft version
  `draft-ietf-oauth-identity-assertion-authz-grant-04`.
- `api-key` remains parseable for legacy providers, but selection flags it as a
  last-resort static-secret path.
- Manifest envelopes require a fixture signature whose issuer matches the
  `auth.json` issuer, and signed payloads reject undeclared raw fields before
  digest comparison. This proves the trust-boundary check without implementing
  Registry crawling or production public-key verification.

## Proof Boundaries

This proof validates and normalizes the contract. It does not perform provider
STS exchange, OAuth token exchange, live OIDC discovery, Registry crawling, or
real cryptographic signature verification. Those are owned by later Identity,
Registry, and broker runtime slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-json-contract test
```

The checks prove:

- the versioned schema publishes the required `auth.json` top-level fields,
- the documented example shape validates and resource indicators parse,
- keyless flows are preferred before static secrets,
- unsigned, wrong-issuer, and tampered manifest envelopes fail,
- XAA pins the ID-JAG draft and is preferred over OAuth OBO,
- mismatched OIDC discovery hosts and invalid XAA declarations fail,
- duplicate flow entries fail closed.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Auth Json Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
