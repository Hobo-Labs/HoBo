# HOBO-36 - Host-Version Pinning + Gated Upgrade Proof

This proof pins the component-host compatibility contract from
`wasm-runtime-wit.md#plan-20`, ADR-0031 section 5, and ADR-0024 section 5:

- Manifest IR records the certified host kind and version before planning.
- A pinned vN manifest fails planning on an incompatible Camp host with
  `component_host.host-version-incompatible`.
- Semantics-changing host upgrades run only through an explicit gated upgrade
  path with a verified upcaster.
- A semantics-changing host upgrade without a verified upcaster is blocked
  without rewriting the manifest.
- `hobo doctor` reports host lock-in and whether a target host is ready,
  ready-with-upcaster, or blocked.

Executable proof lives in `src/draft/technical-proofs/host-version-upgrade-contract`.

Scope intentionally excludes an upcaster authoring framework and concrete
adapter upgrades; this POC only defines the planning/doctor contract that those
future implementations must satisfy.
