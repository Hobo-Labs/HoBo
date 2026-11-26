# Performance & Load Tests Scope Contract

HOBO-440 defines the M0 scope and acceptance record for the Performance & Load Tests
productization project.

## What This Proves

- The Performance & Load Tests project has an explicit user/business goal and five primary
  personas.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are machine-checkable.
- The scope record depends on Plan 05, the E2E Test Matrix, the launch persona matrix, the
  pre-launch outcome contract, ADR-0045, and ADR-0082.
- Owning initiative dependencies are mapped without moving E2E matrix, release cutline,
  reliability/FinOps, support, or security implementation into this issue.
- M1 evidence requirements are listed with owner, proof mode, and what each item proves.
- Follow-up M1-M4 work remains gated until M0 acceptance is recorded.

## Boundary

This package validates the M0 Performance & Load Tests scope record. It does not build a load
runner, benchmark lab, browser performance lab, CI execution lane, live-provider stress test,
production load path, autoscaling implementation, chaos experiment, or launch decision.

## Architecture Evidence

Per the repository architecture guardrails, this package documents how its scope record is
schematized, parsed, and consumed:

- [`proto/performance_load_tests_scope.proto`](./proto/performance_load_tests_scope.proto) — protobuf
  data shapes for the scope record.
- [`cue/performance_load_tests_scope.cue`](./cue/performance_load_tests_scope.cue) — CUE constraints for
  every protobuf type.
- [`contracts/pacts/m0-scope-acceptance-gate.pact.json`](./contracts/pacts/m0-scope-acceptance-gate.pact.json)
  — PACT contract for the M0 follow-up gate and evidence-gap routing boundary.
- [`ADR.md`](./ADR.md) — parse-don't-validate discipline and the command/event/actor/
  event-store/projection/snapshot/read-store framing for an accepted scope record.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\performance-load-tests-scope-contract test
```
