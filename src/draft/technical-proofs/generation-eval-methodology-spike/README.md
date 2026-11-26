# Generation Eval Methodology Spike

Independent POC for HOBO-351. It records the ADR-0098 recommendation in an executable shape so the
decision can be checked like a contract before implementation work starts.

## Recommendation

- Use a hybrid evaluator: programmatic checks, golden-trajectory reproduction, LLM judges, and
  human-label calibration where semantic quality needs it.
- Treat `trajectoryGolden` as the stable Golden Suite primitive for generated implementations and
  trainable semantic functions.
- Require train/held-out/adversarial split separation and independent calibration so the optimizer
  cannot promote by gaming its own judge.
- Keep min-sample floors explicit; underpowered evals stay in shadow as `inconclusive`.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-eval-methodology-spike test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Eval Methodology Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
