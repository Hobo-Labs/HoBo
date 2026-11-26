# HOBO-13 Runtime Primitive Interfaces

Proof package: [`src/draft/technical-proofs/hobo-runtime-primitives`](../../../../src/draft/technical-proofs/hobo-runtime-primitives)

This POC records the first `hobo:runtime@0.1.0` WIT primitive contract from
Plan 20 / ADR-0072:

- The package is generated through `jco types`, proving the WIT parses and
  guest bindings emit.
- The no-op guest stub imports every primitive interface and typechecks with
  `tsc --noEmit`, proving the intended app-side dependency shape builds.
- The SDK primitive table is checked against WIT names so `workflow`/`step`/
  `actor`/`saga`/`agent`/`command`/`subscribe` signatures cannot drift silently.
- The replay-safety checklist rejects wall-clock/random primitives, keeping the
  HOBO-13 adversarial case executable.
