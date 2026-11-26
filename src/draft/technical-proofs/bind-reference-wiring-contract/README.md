# Bind Reference Wiring Contract

Independent POC for HOBO-49. It pins the `bind: { ... }` reference contract as
an Aspire-style lazy reference:

- a bind records a manifest `links` edge from consumer import to target resource;
- fallback/container injection uses `ConnectionStrings__<name>` lazy tokens;
- `ctx.bindings.<name>` is generated from the bound resource's port client type;
- `addContainer(...)` records build and wiring metadata in one fluent surface:
  `withHttpEndpoint` / `withEndpoint` / `withEnvironment` / `withArgs` /
  `withBindMount` / `withVolume` / `withLifetime` / `waitFor` /
  `waitForCompletion` / `withHttpHealthCheck`;
- unknown binds and unresolved lazy references fail closed during collection.

The POC intentionally does not implement provider realization, runtime injection,
planner ordering, `.with()` provider-specific typing, DNS, or cross-Camp wiring.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Bind Reference Wiring Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
