# Runaway Spend Circuit-Breaker Contract

This independent POC backs HOBO-306, [PLAN-05](../../../../docs/design/reliability-observability-cost.md#plan-05),
and [ADR-0039](../../../../docs/design/adr/02-identity-security.md#adr-0039). It models the last-resort
spend circuit-breaker that trips from `MeteringView` spend velocity, emits durable
`spend.CircuitTripped` / `spend.CircuitReset` facts, and gates spend-incurring actions while the
breaker is open.

The package intentionally does not implement graceful degradation tiers, hard budget denial,
provider reliability breakers, runtime wiring, or provider adapters. It consumes their contract
outputs: seq-pinned metering snapshots, degradation-exhausted evidence, and action admission
requests.

## Contract

- `evaluateRunawaySpendCircuitBreaker(input)` folds prior `spend.*` breaker events, evaluates a
  debounce window over metering velocity samples, optionally accepts an ack/reset, and returns an
  action decision plus newly emitted breaker events.
- `replaySpendCircuitEvents(events)` reconstructs durable breaker state after restart from
  `spend.CircuitTripped` and `spend.CircuitReset`.

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
| Breaker must allow in-flight compensation | `compensation actions bypass the halt while the breaker is open` |
| Repeated trip/reset flapping | `cooldown prevents reset flapping` |
| Ack races fresh spike | `ack racing a fresh spike fails closed without reset` |

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\runaway-spend-circuit-breaker-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Runaway Spend Circuit Breaker Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
