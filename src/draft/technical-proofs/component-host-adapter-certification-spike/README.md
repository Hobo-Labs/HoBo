# HOBO-35 Component-Host Adapter Certification Spike

This independent POC decides the first opt-in `component-host` adapter
certification target and makes the acceptance criteria executable without
implementing a production adapter.

Decision:

- Certify **SpinKube / containerd-wasm** first because it can preserve the
  Wasmtime-shaped component-host semantics closest to the local and OCI-floor
  profiles.
- Treat provider-native wasm, represented by the Cloudflare Workers fixture, as
  a gap-list path until the required pinned `wasi:*` interfaces and
  determinism controls pass `@hobo/conformance/component-host`.

Acceptance mapping:

- `certifyComponentHostAdapter(createSpinKubeAdapterProfile())` runs the
  existing component-host conformance suite from Wasmtime local to SpinKube and
  returns a certified report.
- The report records covered assertions and declared non-covered divergences:
  wall-clock scheduling jitter and host-specific partial-failure timing.
- The cross-host E2E fixture proves the same component descriptor on
  `runtime-local` -> `spinkube` with conformance-equivalent behavior.
- `host.spinkube.with("linkMigration")` applies on SpinKube, is inert on other
  hosts, and is flagged by the doctor output as host lock-in.
- A functionally plausible adapter that drifts on NaN canonicalization,
  fuel/epoch scheduling, or resource-limit semantics fails conformance.
- A provider-native profile missing required `wasi:*` interfaces fails planning
  with machine-readable reasons before adapter selection.

Run it with:

```powershell
npm.cmd --prefix src\draft\technical-proofs\component-host-adapter-certification-spike test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Component Host Adapter Certification Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
