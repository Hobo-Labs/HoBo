# Executor skeleton contract

Independent proof for HOBO-72. The package models the Yard Executor as an
in-process contract over an `IacProgram`: request a short-lived scoped token,
run the fixture program, stream `exec.*` events, capture outputs, and always
release the token.

## Proven Behavior

- Successful fixture programs emit `exec.Started`, `exec.Output`, and
  `exec.Succeeded` events accepted by the HOBO-39 control-plane event schema.
- Failing programs end in `exec.Failed` with retryable or fatal classification.
- Per-executor concurrency limits reject over-limit work before a second token is
  issued.
- Mid-run token expiry fails closed and revokes the scoped token.
- A severed output stream is classified as ambiguous and requires reconciliation.
- An executor crash after start emits `exec.Failed` and leaves no orphaned
  credential.
- The Relay routing seam records routed work and results without owning provider
  execution logic.

## Scope Boundaries

This is a contract POC, not a real sandbox. It does not implement Firecracker,
real provider/IaC adapters, real Identity issuance, the HoBo Relay, driver
realization logic, or persistent executor pools. Those remain owned by their
separate provider, identity, networking, and runtime slices.

## Check

```powershell
npm.cmd --prefix src\draft\technical-proofs\executor-skeleton-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Executor Skeleton Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
