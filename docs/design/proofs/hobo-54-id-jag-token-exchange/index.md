# HOBO-54 ID-JAG Token-Exchange Proof

This proof pins the M0 Cross-App Access wire contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06) and
[ADR-0084](../../adr/02-identity-security.md#adr-0084).

## Contract Surface

- The active draft is pinned as
  `draft-ietf-oauth-identity-assertion-authz-grant-04`.
- Stage 1 builds a Token Exchange request for an ID-JAG and parses the response.
- Stage 2 builds and parses the JWT bearer grant that redeems the ID-JAG.
- A response minted for audience A is invalid for audience B.
- Malformed and expired assertions fail closed.
- `subject.delegatedBy` is required and must identify a user.
- Nonce replay is rejected by the contract parser.

## Proof Boundaries

This is structural proof. It does not issue live tokens, perform OAuth calls, verify
production signatures, run policy deny-ceilings, implement `connector()`, or implement
inbound HoBo resource-server verification.

## Executable Checks

```powershell
npm.cmd --prefix src\draft\technical-proofs\id-jag-token-exchange-contract test
```
