# Golden Suite Chaos Verification Contract

This draft POC proves HOBO-329's composition boundary for Golden Suites, SLO burn, and the
first-class chaos verification tier. It consumes existing SLO status and chaos experiment shapes
without implementing the SLO engine, fault primitives, or external chaos adapters.

## Contract

- `evaluateGoldenSuiteChaosTier(input)` evaluates a Golden-suite run, CI target coverage,
  error-budget policy, and a bounded chaos experiment.
- `replayGoldenChaosTier(events)` rebuilds the terminal verification status from emitted events.
- `GOLDEN_CHAOS_EVENT_TYPES` pins the `golden.*`, `policy.Decided`, `chaos.*`, and
  `rollout.AutoRollbackRequired` facts used by downstream rollback or operator surfaces.
- `SUPPORTED_FAULT_INJECTORS` pins provider 429, provider 503, node loss, partition, latency, and
  severed-link fault kinds; undeclared faults fail closed.

## Scope

In scope:

- Golden-suite pass/fail/quarantine as rollback input.
- runtime-local plus Camp coverage enforcement for CI.
- node-loss steady-state checks against a deploy-resume SLO invariant.
- provider 429/503, node loss, partition, latency, and severed-link injector declarations.
- prod chaos denial before fault injection when policy budget or blast radius would be exceeded.
- dead-man aborts, blast-radius leak aborts, and injector cleanup failure.

Out of scope:

- SLO computation and multi-window burn-rate math.
- low-level membrane fault primitives and external chaos engines.
- Harness rollout adapters, dashboards, and the SRE operator.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\golden-suite-chaos-verification-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Golden Suite Chaos Verification Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
