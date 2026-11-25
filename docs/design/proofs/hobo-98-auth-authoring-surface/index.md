# HOBO-98 auth authoring surface proof

This proof covers the authoring side of [`hobo:auth`](../../ai-native-agent-auth.md#plan-06), aligned to [ADR-0038](../../adr/02-identity-security.md#adr-0038) and [ADR-0070](../../adr/02-identity-security.md#adr-0070).

Executable package: [`src/draft/technical-proofs/hobo-auth-authoring-surface`](../../../../src/draft/technical-proofs/hobo-auth-authoring-surface/README.md).

Proven boundaries:

- Provider declarations lower OIDC, custom JWT, and built-in auth into a secret-free manifest entry carrying issuer, JWKS, and algorithm verification config.
- Generated client/server types narrow `signIn()` to configured providers and carry typed `ctx.user` claims plus fail-closed `ctx.tenant` metadata.
- The authoring surface emits the same consumer-driven `hobo:auth` contract that can-deploy and the contract-asserted dev principal fixture use.
- Custom JWT rejects missing JWKS and `alg:none`; built-in auth is marked dev/air-gap and cannot satisfy production can-deploy by itself.

Out of scope remains runtime verification, session revocation, policy enforcement, inbound XAA runtime, and hosted IdP behavior.
