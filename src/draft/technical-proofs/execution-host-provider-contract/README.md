# Execution Host Provider Contract POC

Independent POC for HOBO-149.

This package pins the `RunnerProvider` and `BuildMachineProvider` contract
surface for cost-routed execution hosts. It intentionally stays local to the
draft package: real GitHub, Blacksmith, Depot, Relay, Executor, Dispatcher, and
build-wasm implementations remain separate slices.

Proven behavior:

- self-hosted `RunnerProvider` runs a fixture CI job and emits runner lifecycle
  facts;
- self-hosted `BuildMachineProvider` delegates a build to a fixture build-wasm
  provider and returns an OCI `ImageRef`;
- both providers publish a capability manifest with declared `cost.json`
  free-tier facts;
- a Dispatcher fixture ranks only registered providers by
  `CreditLedgerView@seq` input and records a `dispatch.Decided` body;
- provider cost facts are marked `declared-unverified`, not blindly trusted;
- `.with(...)` provider pins opt out of routing but still require a registered
  provider;
- exhausted build-machine credit fails before a build is delegated.

Run:

```sh
npm test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Execution Host Provider Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
