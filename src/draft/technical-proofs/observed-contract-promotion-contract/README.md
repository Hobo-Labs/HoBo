# Observed Contract Promotion Contract

Independent POC for HOBO-126.

This package pins the observed-contract trace-mining and promotion seam for
Plan 29:

- baseline `contract.TraceObserved` events mine a Contract IR `observed` shape
  with sample coverage and field coverage;
- lane-origin traces are excluded by default so fork/preview experiments cannot
  poison the baseline contract;
- an observed contract promotes to a versioned gate carrying the same coverage
  and an explicit migration window;
- unobserved producer variants inside the migration window emit
  `compat.GateFailed` instead of silently passing;
- low-sample promotions remain confidence-bounded and require review;
- poisoned trace samples fail closed.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\observed-contract-promotion-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Observed Contract Promotion Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
