# HOBO-72 Executor Skeleton Proof

This executable proof pins the M1 Executor skeleton from
[Plan 04](../../control-plane.md#executor-sandbox-model),
[Plan 10](../../architecture.md#key-boundaries--invariants), and
[Plan 25](../../platform-engineering.md#the-hobo-relay-deploy-into-private-networks).

## Contract Surface

- Dispatch accepts a fixture `IacProgram`, brokered token scope, resource id, and action.
- A successful in-process run streams `exec.Started -> exec.Output -> exec.Succeeded`.
- Failure paths emit `exec.Failed` with retryable, fatal, or ambiguous classification.
- The token broker records issue/revoke audit facts and has zero active tokens after every run.
- Concurrency backpressure rejects over-limit work before a second token is issued.
- The Relay routing seam records work/result routing while execution remains in-process.

## Proof Boundaries

This proof is a contract POC. It does not implement Firecracker internals, real sandboxing,
real Identity token issuance, Relay transport, provider/IaC driver realization, executor
pool warmup, or persistent queueing. It proves the executor seam those later slices consume.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\executor-skeleton-contract test
```

The checks prove successful streaming, typed failure classification, concurrency rejection,
mid-run token-expiry fail-closed behavior, ambiguous output-stream loss, no orphaned credential
after executor crash, and a pluggable Relay routing seam.
