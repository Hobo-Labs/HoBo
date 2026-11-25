# Policy pack federation contract POC

Independent POC for HOBO-150.

This package proves the signed policy-pack boundary around the existing policy
IR, deny-ceiling algebra, and built-in policy engine contracts. It models a
policy pack as a versioned, scoped, signed resource that can be bound to
Junction/Yard/Camp/Bindle targets and propagated across a Junction without a
shared controller.

## Contract boundaries

- In scope: Ed25519 signed pack envelopes, semver pack versions, target binding,
  fail-closed verification, versioned pack IDs in decision evidence, and
  `junction.PolicyPropagated` delivery records for peer Yards.
- Consumed but not owned: `hobo.policy-ir/v1`, the deny-ceiling composition
  algebra, and the built-in TypeScript policy engine.
- Out of scope: the composition algebra design, policy-engine evaluation logic,
  action-taxonomy content, pack generation, registry mirroring, and OCSF export.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\policy-pack-federation-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Pack Federation Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
