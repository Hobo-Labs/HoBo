# hobo:sdk aggregate WIT contract POC

> **Promoted to production:** the import-only `hobo:sdk@0.1.0` aggregate world now ships from [`packages/wit/wit/hobo-sdk.wit`](../../../../packages/wit/wit/hobo-sdk.wit) with cross-package imports (`@hobo/wit`, HOBO-590). Reverse-extraction tooling remains draft-only.

This draft owns HOBO-16's branch proof for the `hobo:sdk` aggregate WIT package and reverse-extraction drift gate.

It models the canonical `hobo:sdk@0.1.0` world as a single WIT package that imports the runtime primitives (`workflow`, `actor`, `saga`, `agent`, `command`, `subscription`) plus capability/data interfaces. The checked-in test suite runs `jco types wit` to prove the aggregate parses and produces TypeScript guest types for the full surface.

The reverse-extraction CLI is intentionally a small POC: it parses the authored WIT, reads a fixture artifact imports/exports manifest, compares forward and reverse surfaces, writes a parity/adoption report, and refuses to scaffold an idiom-layer skeleton when imports, exports, or imported function signatures drift.

Scope boundaries:

- No conformance-suite gate for idiom parity.
- No production idiom layer.
- No domain-record authoring.
- No provider placement or cloud logic.

Run:

```powershell
npm.cmd install
npm.cmd test
npm.cmd run reverse:fixture
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Sdk Aggregate Wit Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
