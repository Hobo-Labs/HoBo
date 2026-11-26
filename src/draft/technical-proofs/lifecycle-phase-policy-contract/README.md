# Lifecycle Phase Policy Contract POC

This draft proves HOBO-137's lifecycle-phase policy boundary.

It consumes the HOBO-91 Policy IR and records:

- phase-scoped rule declarations over the ten canonical lifecycle phases;
- a starter pack with one representative rule per phase from Plan 29;
- fail-closed behavior for unknown or forged phases;
- phase isolation so a rule scoped to one phase cannot fire in another;
- runtime delegated-scope enforcement even when an action is author-time allowed;
- fail-closed runtime and promote evaluation when required evidence is missing;
- repair-phase prod auto-fix denial with preview auto-fix still allowed;
- `policy.Decided` audit evidence carrying the evaluated phase and matched rules.

## Boundary

This POC does not implement full domain policy packs, obligation execution, OPA/Cedar adapters, OCSF export, or policy-pack signing.

## Verification

```sh
npm.cmd --prefix src/draft/technical-proofs/lifecycle-phase-policy-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Lifecycle Phase Policy Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
