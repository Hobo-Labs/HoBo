# HOBO-66 Identity Event Contract Proof

This executable proof pins the M0 contract for identity, token, session, secret,
and config audit events from [Plan 6](../../ai-native-agent-auth.md#plan-06),
[ADR-0008](../../adr/02-identity-security.md#adr-0008),
[ADR-0023](../../adr/02-identity-security.md#adr-0023), and
[ADR-0084](../../adr/02-identity-security.md#adr-0084).

## Contract Surface

- `identity.Issued` and `identity.Rotated` record SVID lifecycle facts.
- `token.Granted`, `token.Used`, `token.Denied`, and `token.Revoked` record the
  brokered-token lifecycle.
- `user.Authenticated` and `session.Started/Refreshed/Revoked` record the app-user
  auth path.
- `secret.Accessed` joins a secret reference to a `token.Used` fact.
- `config.Resolved` records ref -> source, never a config value.
- All streams are marked never-compact security-audit facts.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\identity-event-contract test
```

The checks prove that the event schemas validate fixtures, the CredentialAudit
projection folds a user -> agent -> external-app chain, missing grants become
anomalies, secret/config plaintext is rejected, and revocation stays append-only.
