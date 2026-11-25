# HOBO-150 policy pack federation proof

This proof pins the HOBO-150 contract slice: signed, versioned, scoped policy
packs can be verified, bound to targets, federated across a Junction, and
composed by the existing deny-ceiling algebra.

Proof vectors live in
`src/draft/technical-proofs/policy-pack-federation-contract/test/policy-pack-federation.test.ts`.
They cover:

- signed pack load and versioned decision evidence;
- unsigned, wrong-key, and tampered packs rejected fail-closed;
- identical deny-set composition after Junction delivery to two peer Yards;
- mandatory deny-ceiling behavior vs overridable default rules;
- signature coverage for mandatory flags;
- union-of-denies for conflicting federated mandatory packs.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-pack-federation-contract test
```
