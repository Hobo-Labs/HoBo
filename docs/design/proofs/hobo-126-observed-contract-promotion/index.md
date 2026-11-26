# HOBO-126 Observed Contract Promotion Proof

This proof backs [PLAN-29](../../contracts-policy-flags.md#plan-29),
[ADR-0015](../../adr/02-identity-security.md#adr-0015), and
[ADR-0076](../../adr/02-identity-security.md#adr-0076).

The executable POC in
[`src/draft/technical-proofs/observed-contract-promotion-contract`](../../../../src/draft/technical-proofs/observed-contract-promotion-contract)
proves the M2 observed-contract slice:

- trace corpora mine Contract IR `observed` contracts with recorded sample
  coverage and field coverage;
- lane-origin trace events are excluded by default, so a fork burst does not
  alter the baseline mined contract;
- promotion produces a `promoted` Contract IR version plus an
  `hobo.observed-contract-promotion/v1` gate carrying the migration window;
- unobserved producer variants during that window emit `compat.GateFailed` with
  a machine-readable reason and fixes;
- thin samples produce low-confidence review gates rather than claiming proof;
- malformed trace samples fail closed instead of shifting the shape.

Verification:

```powershell
npm.cmd --prefix src\draft\technical-proofs\observed-contract-promotion-contract test
```
