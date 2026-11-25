# HOBO-35 Component-Host Adapter Certification Spike

HOBO-35 decides that the first opt-in `component-host` adapter certification
target is **SpinKube / containerd-wasm**, not provider-native wasm. The
branch-level proof is
[`src/draft/technical-proofs/component-host-adapter-certification-spike`](../../../../src/draft/technical-proofs/component-host-adapter-certification-spike/README.md).

Evidence:

- The SpinKube profile runs through the existing
  `@hobo/conformance/component-host` POC against Wasmtime local.
- The certification report separates covered assertions from declared
  non-covered divergences.
- The same component descriptor is asserted from Wasmtime local to SpinKube.
- `host.spinkube.with("linkMigration")` is typed, inert on non-SpinKube hosts,
  and surfaced as `hobo doctor` host lock-in.
- Provider-native wasm missing pinned `wasi:*` interfaces fails planning with a
  precise reason instead of pretending to be compatible.
- NaN, fuel/epoch, and resource-limit drift is caught by conformance.

This remains a spike. It does not production-harden the adapter, implement the
wasmCloud lattice host, or certify additional provider-native adapters.
