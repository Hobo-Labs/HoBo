# Domain Event Body Contract POC

This package is an independent proof for HOBO-42. It pins the M0 typed domain
event-body contract:

- Canonical WIT records as the single upstream for event body, projection, and mapping shapes.
- Generated TypeScript, Protobuf descriptor, Zod validator source, and CUE constraint views.
- Byte-stable Protobuf event-body round trips without implementing `EventEnvelope` storage.
- Zod/WIT authoring parity and fail-closed divergence checks.
- Constraint and version-evolution guards for invalid values and non-additive field renames.

Out of scope by design: EventStore append/read behavior, PACT provider/consumer testing,
upcaster chains, and projection-sink migrations.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\domain-event-body-contract test
npm.cmd --prefix src\draft\technical-proofs\domain-event-body-contract run codegen:check
```

Fixture comparisons normalize CRLF to LF so generated-artifact parity checks pass on Windows CI (S0 stage gate matrix).

Promoted protobuf→TS + `codegen:check` drift gate to draft POC `src/draft/technical-proofs/s0-04-protobuf-cue-codegen/` (HOBO-581 / S0-04); production target is `packages/schema-tools/`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Domain Event Body Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
