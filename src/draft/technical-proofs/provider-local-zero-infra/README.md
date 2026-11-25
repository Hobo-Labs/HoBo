# HOBO-135 Local Provider POC

This draft implements the M1 `@hobo/provider-local` contract for the zero-infra floor:

- factory + `.with(...)` builders for `database`, `objectStore`, `compute`, and `queue`
- default Resource Definitions for the local provider
- `capabilityManifest()` with explicit `local` conformance tags and no `camp` fidelity claim
- `realize()` emission using the HOBO-112 `IacProgram` / `BuildSpec` shape
- local runtime fixture that provisions descriptor-backed Postgres, filesystem object store, container, and in-memory queue resources
- typed local clients for DB descriptors, object-store IO, queue drain/publish, and compute descriptors
- lock fencing for concurrent provisions against one shared local backend

The queue is intentionally marked `fidelity: "mock"` because the in-memory implementation is useful
for `hobo dev` but does not prove Camp delivery guarantees.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-local-zero-infra test
```

Relevant design records:

- `docs/design/control-plane.md`: provider package authoring, local/container provider, and `realize()` emission
- `docs/design/architecture.md`: `providers/provider-local` package placement and port layering
- `docs/design/generated-stack.md#plan-09`: local-vs-camp conformance tags
- `docs/design/adr/07-portability-extensibility.md#adr-0042`: local-dev fidelity honesty


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Local Zero Infra.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
