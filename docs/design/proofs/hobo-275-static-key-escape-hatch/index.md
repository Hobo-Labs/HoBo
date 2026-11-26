# HOBO-275 static-key escape hatch proof

This executable proof backs [PLAN-06](../../ai-native-agent-auth.md#plan-06),
[PLAN-12](../../security-networking.md#plan-12),
[PLAN-21](../../authoring-resources-wiring.md#plan-21),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0027](../../adr/02-identity-security.md#adr-0027).

The proof lives in
[`src/draft/technical-proofs/static-key-escape-hatch-contract`](../../../../src/draft/technical-proofs/static-key-escape-hatch-contract)
and models the static-secret branch only. It proves that the last-resort path is
bounded by:

- max TTL `P7D` by default, configurable down only;
- expiry fail-closed with `StaticKeyExpiredError`;
- enforced rotation via `rotationDueAt`;
- explicit per-use opt-in;
- joined `token.Used` and `secret.Accessed` audit on every successful fetch;
- envelope-reference persistence with redacted runtime wrappers; and
- no plaintext static key in Bindle, Camp, events, logs, spans, or training
  trajectories.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\static-key-escape-hatch-contract test
```
