# HOBO-99 SVID Auto-Rotation Proof

This executable proof pins the M2 SVID rotation contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06) and
[ADR-0008](../../adr/02-identity-security.md#adr-0008).

## Contract Surface

- A long-running workload rotates its JWT-SVID before TTL expiry.
- Rotation records `identity.Rotated` and keeps token material out of audit events.
- The rotated SVID carries the same or narrower scope, never a widened grant.
- Rotation refuses a lost attestation or a changed code-version without silent reuse.
- The overlap window keeps at least one SVID valid and retires the old SVID after overlap.

## Proof Boundaries

The proof consumes HOBO-90 issuance semantics and the existing identity-event/JWT-SVID/attestation
POCs. It does not implement initial issuance, network-partition rotation, mTLS certificate rotation,
broker credential-cache HA, or production signing-key operations.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\svid-auto-rotation-contract test
```

The checks prove timely rotation, `identity.Rotated` emission, scope non-escalation, fail-closed
lost attestation, code-version re-evaluation, and overlap gap prevention.
