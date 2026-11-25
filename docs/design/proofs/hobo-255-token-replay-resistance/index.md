# HOBO-255 Token Replay Resistance Proof

This proof hardens the Plan 06 identity surface against captured credential
reuse across JWT-SVIDs, ID-JAG assertions, provider access tokens, and inbound
HoBo app tokens.

Design refs:

- [ai-native-agent-auth.md](../../ai-native-agent-auth.md#plan-06)
- [ADR-0008](../../adr/02-identity-security.md#adr-0008)
- [ADR-0084](../../adr/02-identity-security.md#adr-0084)
- [ADR-0097](../../adr/02-identity-security.md#adr-0097)
- [ADR-0100](../../adr/02-identity-security.md#adr-0100)

Executable artifact:

- [`src/draft/technical-proofs/token-replay-resistance-contract`](../../../../src/draft/technical-proofs/token-replay-resistance-contract)

Acceptance evidence:

- JWT-SVID replay is rejected after expiry and after the retired signing `kid`
  leaves the rollover window.
- ID-JAG replay at a second target is rejected with an audience-mismatch reason.
- Outbound and inbound consumed nonces reject every replay after the first
  successful redemption.
- Provider access-token reuse after expiry is rejected at the exact boundary.
- Fresh first use of every credential family succeeds inside its validity
  window.
- Each rejected replay emits a validated `token.Denied` event whose reason
  matches the returned denial and whose body carries only references, not raw
  credential material.

Scope boundary:

- No production issuer, STS, broker cache, resource server, or provider
  implementation changes.
- No lane-token replay defense, confused-deputy proof, or threat-model update.
- No new architectural decision; this consumes the existing Plan 06, ADR-0008,
  ADR-0084, ADR-0097, and ADR-0100 requirements.
