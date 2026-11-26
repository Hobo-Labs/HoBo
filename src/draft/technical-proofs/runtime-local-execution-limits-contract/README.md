# Runtime-Local Execution Limits Contract POC

Independent proof for HOBO-400.

This package models the runtime-local component-host execution-limit boundary
that HOBO-17 intentionally deferred. It uses a Wasmtime-shaped host stub and
guest fixtures to prove fuel, epoch, and resource-limit interruption semantics
without adding cross-process lattice limits, container packaging, deterministic
clock replay, or broader grant inference.

## Contract Boundaries

- In scope: runtime-local fuel budget, epoch deadline, memory limit, typed
  execution-limit error mapping, lease cleanup, safe teardown ownership after
  cleanup traps, and audit facts for interrupted guests.
- Consumed but not owned: the HOBO-17 component lifecycle/link-table skeleton
  and the PLAN-20/ADR-0031 component-host portability requirement.
- Out of scope: cross-process lattice execution limits, container packaging,
  deterministic-clock replay suites, and deny-by-default grant inference.

## Proof

```powershell
npm.cmd --prefix src\draft\technical-proofs\runtime-local-execution-limits-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runtime Local Execution Limits Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
