# HOBO-306 Runaway Spend Circuit-Breaker Proof

This proof backs [PLAN-05](../../reliability-observability-cost.md#plan-05) and
[ADR-0039](../../adr/02-identity-security.md#adr-0039).

The branch adds
[`src/draft/technical-proofs/runaway-spend-circuit-breaker-contract`](../../../../src/draft/technical-proofs/runaway-spend-circuit-breaker-contract/README.md),
an independent POC for the durable, last-resort spend circuit-breaker saga. It consumes
seq-pinned `MeteringView` snapshots and degradation-exhausted velocity samples, emits
`spend.CircuitTripped` / `spend.CircuitReset`, replays breaker state after restart, and gates
spend-incurring actions while still allowing non-spend work and in-flight compensation.

Scope kept out: graceful degradation tier enforcement, hard budget denial/reservations,
provider-resilience circuit breakers, runtime wiring, and provider adapters.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Simulated spend spike trips breaker and halts spend actions | `sustained spend spike trips durable breaker and denies spend action` |
| Ack resets breaker | `operator ack after cooldown emits CircuitReset and reopens spend actions` |
| Breaker state survives restart | `replay reconstructs open breaker after restart and blocks spend` |
| Non-spend actions proceed while tripped | `non-spend actions proceed while breaker is open` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Metering lag or burst creates false trip | `single burst and stale metering samples do not trip breaker` |
| Graceful degradation must be exhausted first | `degradation must be exhausted before breaker trips` |
| Breaker must allow in-flight compensation | `compensation actions bypass the halt while the breaker is open` |
| Repeated trip/reset flapping | `cooldown prevents reset flapping` |
| Ack races fresh spike | `ack racing a fresh spike fails closed without reset` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runaway-spend-circuit-breaker-contract test
npm.cmd test
```
