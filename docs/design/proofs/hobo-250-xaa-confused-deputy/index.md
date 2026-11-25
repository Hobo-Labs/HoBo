# HOBO-250 XAA Confused-Deputy Proof

This proof hardens outbound Cross-App Access by forcing the pre-mint policy
decision to use the verified user delegation chain, not a caller-supplied
`subject.delegatedBy`.

Design refs:

- [ai-native-agent-auth.md](../../ai-native-agent-auth.md#plan-06)
- [ADR-0074](../../adr/02-identity-security.md#adr-0074)
- [ADR-0084](../../adr/02-identity-security.md#adr-0084)
- [ADR-0097](../../adr/02-identity-security.md#adr-0097)

Executable artifact:

- [`src/draft/technical-proofs/xaa-confused-deputy-guard-contract`](../../../../src/draft/technical-proofs/xaa-confused-deputy-guard-contract)

Acceptance evidence:

- A verified Priya delegation mints an audience-bound ID-JAG through the existing outbound XAA broker.
- `policy.Decided` is emitted before `token.Granted` and `token.Used`.
- The target authorization-server fixture sees the broker-derived `subject.delegatedBy`.

Adversarial evidence:

- A forged Mallory `subject.delegatedBy` is denied before ID-JAG minting or target authorization-server calls.
- A target without a matching delegated grant is denied before minting.
- A valid Asana delegated grant cannot be reused to mint for Slack.
- Missing `verifiedDelegatedBy` fails closed and emits `token.Denied`.
- A non-user verified delegation principal fails closed before minting.

Scope boundary:

- No production IdP verifier, policy store, policy-pack authoring, inbound resource-server validation, or scope inference implementation.
- No changes to the HOBO-230 outbound XAA broker beyond composing it as the allowed path.
