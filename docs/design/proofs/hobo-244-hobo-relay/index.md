# HOBO-244 HoBo Relay Reverse Tunnel Proof

This executable proof pins the M2 HoBo Relay contract from
[Plan 6](../../ai-native-agent-auth.md#plan-06),
[Plan 12](../../security-networking.md#plan-12),
[Plan 25](../../platform-engineering.md#plan-25),
[ADR-0008](../../adr/02-identity-security.md#adr-0008), and
[ADR-0074](../../adr/02-identity-security.md#adr-0074).

## Contract Surface

- A Relay agent registers and attaches only through governed `hobo:relay:register` and
  `hobo:relay:attach` actions.
- The Relay initiates the tunnel from the private network to the Yard over outbound TCP 443.
- The private network exposes no inbound listener to the Yard.
- Relay attach consumes an X.509-SVID mTLS contract and rejects unauthenticated, expired, or
  cross-tenant SVID attempts.
- One Relay session routes multiple private targets by target id.
- Yard work frames carry private credential references, never credential material.

## Proof Boundaries

This proof consumes the HOBO-242 X.509-SVID mTLS boundary and the existing mTLS data-path contract.
It does not implement SVID issuance, production TCP transport, executor isolation tiers, the
Contracts/Policy authorization engine, or data-plane connectivity tier selection.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-relay-contract test
```

The checks prove outbound-only registration, SVID-authenticated attach, no inbound listener,
target-id routing for two private targets, unauthenticated and wrong-tenant attach rejection,
governed register/attach denial with audit evidence, credential no-egress, and SSRF/lateral
movement resistance.
