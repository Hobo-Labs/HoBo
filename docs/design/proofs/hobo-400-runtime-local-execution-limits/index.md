# HOBO-400 Runtime-Local Execution Limits Proof

This proof covers the M3 hardening slice for runtime-local component-host
fuel, epoch, and resource-limit interruption. It backs
[PLAN-20](../../wasm-runtime-wit.md#plan-20), [ADR-0031](../../adr/01-architecture-core.md#adr-0031),
and the follow-up called out by the [HOBO-17 proof](../hobo-17-runtime-local-component-host/index.md).

## Scope

- `src/draft/technical-proofs/runtime-local-execution-limits-contract` defines a pure
  runtime-local host model over Wasmtime-shaped limits.
- Guest fixtures can exhaust fuel, cross an epoch deadline, allocate beyond a
  memory limit, trap during cleanup, or return a later healthy response.
- The host maps limit interruption to a typed `HostExecutionLimitError`, records
  an `exec.ExecutionLimitTrapped` audit fact, and either releases leases or moves
  them to `runtime-local-teardown` ownership.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Guest fixture exceeding configured fuel/epoch budget is interrupted with a typed error. | `fuel exhaustion interrupts the guest with a typed error, releases leases, and leaves the host live`; `epoch deadline interrupts an infinite-loop guest without poisoning later calls` |
| Host remains live after interruption. | `fuel exhaustion interrupts the guest with a typed error, releases leases, and leaves the host live`; `repeated limit failures do not leak leases or poison the runtime-local host` |
| Leases are released or safely owned for teardown. | `fuel exhaustion interrupts the guest with a typed error, releases leases, and leaves the host live`; `cleanup traps after an execution-limit interruption leave leases safely owned for teardown` |
| Later healthy component call still succeeds. | `fuel exhaustion interrupts the guest with a typed error, releases leases, and leaves the host live`; `repeated limit failures do not leak leases or poison the runtime-local host` |

## Adversarial Mapping

| Risk | Executable proof |
|---|---|
| Infinite-loop guest. | `epoch deadline interrupts an infinite-loop guest without poisoning later calls` |
| Guest allocates until interruption. | `allocation pressure maps to the same typed host error and cleanup fact` |
| Component traps while cleanup runs. | `cleanup traps after an execution-limit interruption leave leases safely owned for teardown` |
| Repeated limit failures leak leases or poison host. | `repeated limit failures do not leak leases or poison the runtime-local host` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runtime-local-execution-limits-contract test
```
