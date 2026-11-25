# HoBo OIDC Federation STS Contract POC

This draft pins the HOBO-110 provider STS exchange slice for
[Plan 6](../../../../docs/design/ai-native-agent-auth.md#plan-06),
[ADR-0008](../../../../docs/design/adr/02-identity-security.md#adr-0008), and
[ADR-0027](../../../../docs/design/adr/02-identity-security.md#adr-0027). It turns
the HOBO-84 broker dispatch seam into an executable OIDC-federation exchange
contract for AWS `AssumeRoleWithWebIdentity`, GCP Workload Identity Federation,
and Azure federated credentials.

## Contract Surface

- Requests carry a caller SVID, subject, target provider, `oidc-federation`
  flow config, and one requested `(port, resource, action)`.
- Expired SVIDs and requests outside the SVID scope fail closed before any
  OIDC assertion is minted or provider STS is called.
- The broker mints a provider-audience OIDC assertion bound to the SVID
  subject, SVID reference, tenant, grant id, and requested scope.
- Mock provider STS adapters receive provider-specific operations:
  `aws:AssumeRoleWithWebIdentity`, `gcp:WorkloadIdentityFederation`, and
  `azure:FederatedCredential`.
- Missing provider trust setup fails closed before assertion minting or STS
  exchange: AWS requires a role ARN, GCP requires a service account, Azure
  requires a client id, and every flow requires `trust.oidcDiscovery`.
- Returned provider credentials are bounded by the SVID expiry and broker max
  TTL, expose only a non-secret credential reference, and carry the narrowed
  permission tuple.
- Provider responses broader than the request are narrowed to the requested
  tuple and flagged with `provider-token-overbroad`.
- Successful exchanges emit validated `token.Granted` and `token.Used` audit
  events without plaintext assertion or credential material.

## Proof Boundaries

This proof does not provision provider trust, call real cloud STS APIs,
implement OAuth-OBO, implement XAA/ID-JAG, use static API-key fallback paths, or
build the broker HA/cache runtime. Those remain separate slices.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\oidc-federation-sts-contract test
```

The checks prove provider-specific STS dispatch, provider trust config
fail-closed behavior, SVID-scoped assertion claims, short-lived provider
credential bounds, static-secret non-use, audit emission, out-of-SVID-scope
denial, over-broad STS narrowing/flagging, and expired SVID rejection.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Oidc Federation Sts Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
