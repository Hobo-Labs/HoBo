# HOBO-110 OIDC Federation STS Proof

This executable proof pins the M2 provider-federation slice from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[ADR-0008](../../adr/02-identity-security.md#adr-0008), and
[ADR-0027](../../adr/02-identity-security.md#adr-0027).

## Contract Surface

- The proof package is
  [`src/draft/technical-proofs/oidc-federation-sts-contract`](../../../../src/draft/technical-proofs/oidc-federation-sts-contract).
- AWS, GCP, and Azure mock STS exchanges receive SVID-bound OIDC assertions
  whose audience matches the provider trust config.
- Missing provider trust setup fails closed before assertion minting or STS
  exchange: AWS role ARN, GCP service account, Azure client id, and
  `trust.oidcDiscovery` are required.
- Provider credentials are short-lived and bounded by both SVID expiry and
  broker max TTL.
- The credential permission surface is exactly the requested
  `(port, resource, action)` tuple; over-broad provider responses are narrowed
  and flagged.
- Successful exchange records `token.Granted` and `token.Used`; denied exchange
  records `token.Denied`.

## Proof Boundaries

This proof stays inside the broker/provider contract seam. It does not create
provider IAM trust, call live cloud STS endpoints, implement OAuth-OBO, implement
XAA/ID-JAG, use static API-key fallback, or build broker HA/cache runtime.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\oidc-federation-sts-contract test
```

The tests cover the HOBO-110 acceptance and adversarial cases: scoped fixture
exchange, provider trust-config failure, short TTL, no static-secret
read/storage, audit events, out-of-SVID-scope denial, provider over-grant
narrowing/flagging, and expired SVID rejection.
