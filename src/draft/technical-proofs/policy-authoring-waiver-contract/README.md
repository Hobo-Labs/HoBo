# Policy authoring waiver contract

HOBO-170 pins the operator-facing policy authoring and gated waiver path from Plan 29 and ADR-0074.
This proof package stays inside the draft boundary: it compiles typed TypeScript policy rules into
policy-pack artifacts, routes policy-pack changes through control-plane create/update/approve
actions, and proves a waiver is scoped, role-gated, time-bounded, audited, and unable to widen a
mandatory deny-ceiling.

Out of scope: the full policy engine, pack signing/federation, break-glass, and OCSF export.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Policy Authoring Waiver Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
