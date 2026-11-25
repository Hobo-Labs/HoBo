# Topology Objects Contract

Independent POC for HOBO-62. It pins the first-class topology object surface:

- `bindle(name, builder)` collects provider-agnostic resource declarations in code;
- `camp(name, ...)` maps one Bindle to one provider-specific target and records runtime, environment type, and mapping overrides;
- `yard(name, ...)` composes Camps for exactly one provider;
- `junction(name, ...)` composes one or more provider-specific Yards;
- per-port resolution precedence is recorded as `bindings -> tiers -> defaultProvider`.

Out of scope: Planner/Matching, inferred auto-placement, connectivity realization, and `camp().config(...)` secret-source mapping.

Run:

```sh
npm.cmd --prefix src/draft/technical-proofs/topology-objects-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Topology Objects Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
