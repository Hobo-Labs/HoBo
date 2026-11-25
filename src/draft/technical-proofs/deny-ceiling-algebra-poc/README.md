# deny-ceiling algebra POC

This draft records the HOBO-128 decision artifact for mandatory policy-rule composition.

The prototype pins:

- Scope order: `Junction -> Yard -> Camp -> Bindle`.
- Mandatory denies compose as a union and are never widened by lower scopes.
- Default rules are recommendations and can be overridden by lower scopes.
- Most-restrictive mandatory limits choose the smallest maximum.
- Composition is deterministic after sorting by scope rank, pack id, and rule id.

Adversarial coverage:

- Malicious pack input order cannot change the effective deny-set.
- A child allow that crosses a parent mandatory deny is rejected at compose time while the deny remains effective.
- Federated mandatory packs that deny different surfaces resolve to the union of denies.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\deny-ceiling-algebra-poc test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Deny Ceiling Algebra Poc.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
