# HOBO-112 Realize Emission Contract POC

This draft pins the M0 `realize()` emission contract from HOBO-112:

- a CloudProvider emits a driver-agnostic `IacProgram`
- an optional `BuildSpec` produces an `ImageRef` that is wired back into the program
- output placeholders are declared and validated before apply
- co-provisioned nodes and runtime links are explicit graph edges
- driver-specific dialect leaks are reported as portability markers instead of silently passing

Scope intentionally stops before concrete Pulumi/OpenTofu/Crossplane execution, build-engine
execution, manifest IR changes, or ResourceActor apply loops.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-realize-emission-contract test
```

Relevant design records:

- `docs/design/control-plane.md`: provider `realize(plan): { iac; build? }`, adapter families,
  resolution pipeline, provider authoring
- `docs/design/platform-engineering.md`: co-provisioning, placeholders, drivers
- `docs/design/adr/01-architecture-core.md`: ADR-0005 and ADR-0006


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Realize Emission Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo/draft-realize-emission-contract test` (Vitest). The
emission/IaC/build types are exported without index signatures so they stay
structurally compatible with each provider's own stricter local interfaces;
`provider-cloudflare-contract`'s strict type-test relies on that compatibility.
