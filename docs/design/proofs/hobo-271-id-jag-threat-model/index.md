# HOBO-271 ID-JAG Threat Model Proof

HOBO-271 is the Cross-App Access spike for ID-JAG threat modeling and draft
version tracking. The decision is recorded in
[ADR-0097](../../adr/02-identity-security.md#adr-0097), and the executable
proof lives in `src/draft/technical-proofs/id-jag-threat-model-spike`.

The proof covers:

- the active draft pin, `draft-ietf-oauth-identity-assertion-authz-grant-04`;
- mandatory review triggers before any future draft bump;
- explicit priority order across the adversarial vectors;
- stage-1 assertion theft/replay;
- stage-2 audience/resource confusion;
- IdP compromise blast radius;
- scope upgrade at redemption;
- draft-version skew;
- forced downgrade from `oauth2-xaa` to `oauth2-obo`;
- actor-token confusion;
- sender-constrained token downgrade;
- refresh-token-as-subject-token broadening.

The package does not implement ID-JAG minting, OAuth calls, production JWKS
verification, policy deny-ceiling execution, or runtime broker behavior. Those
remain with the wire-contract and adversarial implementation slices.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\id-jag-threat-model-spike test
```
