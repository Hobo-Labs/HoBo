# Federated policy pack conflict contract

This draft package is the HOBO-212 adversarial proof for Plan 29, ADR-0074, and
ADR-0096.

It reuses the base `deny-ceiling-algebra-poc` contract and attacks the
federation boundary around it:

- two Yards receiving the same mandatory packs in different orders compute the
  same effective deny set;
- conflicting federated mandatory packs resolve to the union of denies;
- attacker-controlled pack ordering cannot make one Yard more permissive;
- lower-scope attempts to widen a mandatory deny fail closed while preserving
  the effective deny evidence;
- bounded mandatory values use deterministic most-restrictive-wins;
- a late-arriving federated mandatory pack can only add denies, never relax.

## Verify

```powershell
npm.cmd --prefix src\draft\technical-proofs\federated-policy-pack-conflict-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Federated Policy Pack Conflict Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
