# HOBO-149 Execution Host Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0071](../../adr/01-architecture-core.md#adr-0071).

The executable POC in
[`src/draft/technical-proofs/execution-host-provider-contract`](../../../../src/draft/technical-proofs/execution-host-provider-contract)
proves the M1 execution-host provider skeleton:

- `RunnerProvider` exposes `capabilityManifest()` plus `run(job) -> RunnerResult`;
- `BuildMachineProvider` exposes `capabilityManifest()` plus
  `execute(build) -> ImageRef`;
- self-hosted runner/build-machine adapters publish declared `cost.json`
  free-tier facts;
- dispatch selection considers only registered providers and records pinned
  `CreditLedgerView` input in `dispatch.Decided`;
- `.with(...)` pins opt out of routing while still requiring registration;
- declared cost facts are ranking input but remain untrusted evidence;
- credit exhaustion fails closed before a build is delegated.

Scope kept out: GitHub/Blacksmith/Depot adapters, real Relay/Executor sandbox,
Dispatcher reservation CAS, CreditLedgerView projection logic, and the real
build-wasm adapter implementation.
