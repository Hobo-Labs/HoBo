# HOBO-653 Evals + Training Promotion Gates Proof

This proof backs [PLAN-23](../../generated-stack.md#plan-23) and
[ADR-0025](../../adr/03-data-plane.md#adr-0025).

The executable POC in
[`src/draft/technical-proofs/evals-training-promotion-gates-poc`](../../../../src/draft/technical-proofs/evals-training-promotion-gates-poc)
proves the S5-08 promotion-gate skeleton:

- fixture challenger promotes through conformance + eval + policy with
  `training.Promoted` / `impl.Promoted` provenance events;
- rubric-failing challenger is refused and stays shadow;
- OpenInference spans and live-eval rewards export to a tenant OTLP backend;
- lint flags `"use training"` methods missing intent, contract, or rubric.

Scope kept out: production `packages/evals` and `packages/training` layout, real HTTP
OTLP transport, and AST-based linting.
