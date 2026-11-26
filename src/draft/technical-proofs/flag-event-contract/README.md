# HoBo flag event contract POC

This draft implements HOBO-310: IfC flag declarations plus the `flag.*`
event-family contract that sits above the OpenFeature-compatible
`hobo:feature-flag` port from HOBO-299.

## Scope

- `flag.boolean/string/number/object(name, { default, targeting? })`
  declaration helpers that emit `flag.Defined`.
- `flag.Defined`, `flag.Changed`, `flag.Evaluated`, and `flag.Archived`
  event validators.
- Segment/attribute targeting predicates over PrincipalRef-shaped context.
- Replay folding that reconstructs current flag state from the event log.
- Fail-closed guards for actorless changes, incompatible redefinitions, and
  unknown targeting attributes.

## Out of Scope

- Built-in flag store.
- In-process evaluation engine.
- Policy-gated flips and approval obligations.
- Reactive `useFlag` / query invalidation.
- OpenFeature provider adapters.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\flag-event-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Flag Event Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
