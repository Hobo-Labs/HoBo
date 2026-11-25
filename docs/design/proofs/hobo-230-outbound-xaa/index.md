# HOBO-230 Outbound XAA Proof

Refs:

- [PLAN-06](../../ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../adr/02-identity-security.md#adr-0008)
- [ADR-0084](../../adr/02-identity-security.md#adr-0084)

Package:

- `src/draft/technical-proofs/outbound-xaa-token-exchange-contract`

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\outbound-xaa-token-exchange-contract test
```

Acceptance mapping:

- ID-JAG mint is proven by the successful `oauth2-xaa` exchange test, which asserts the minted claims carry target A audience, target A resource, delegated user, nonce, and requested scopes.
- Source-token admissibility is proven by rejecting unsupported token types before policy or minting.
- Target-AS redemption is proven by the fixture authorization server parsing the JWT bearer grant and returning a token reference scoped to target A.
- Audit reconstruction is proven with `foldCredentialAudit(result.events)`.
- Fallback is proven by the non-XAA target test, which asserts no ID-JAG is returned and the fallback exchanger is invoked.

Adversarial mapping:

- Audience binding is proven by attempting target A ID-JAG redemption at target B and receiving an audience mismatch denial.
- Missing `subject.delegatedBy` is denied before pre-mint policy or target authorization-server calls.
- Target credential binding is proven by rejecting redeemed access tokens that omit or mismatch the expected audience.
- Short lifetime is enforced for both ID-JAG parse options and returned target access-token references.
