# HOBO-212 federated policy conflict proof

HOBO-212 hardens the mandatory policy pack model from Plan 29, ADR-0074, and
ADR-0096. The base algebra already defines mandatory deny-ceilings; this proof
adds adversarial federation checks around it.

Proof package:

- `src/draft/technical-proofs/federated-policy-pack-conflict-contract`

Coverage:

- conflicting federated mandatory packs resolve to the union of denies;
- two simulated Yards compute identical deny evidence for the same pack set;
- malicious pack-order permutations cannot change the result;
- lower-scope widening attempts fail closed instead of becoming first-wins;
- most-restrictive bounded limits are deterministic;
- late-arriving federated mandatory packs only add denies.

Scope held:

- no new policy-engine internals;
- no OPA/Cedar adapter work;
- no policy pack signing or distribution implementation.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\federated-policy-pack-conflict-contract test
```
