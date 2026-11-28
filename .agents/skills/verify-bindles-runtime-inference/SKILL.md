---
name: verify-bindles-runtime-inference
description: Verify that Bindle authoring preserves declared and resource-implied runtimes without inventing a runtime for ordinary HTTP handlers.
---

# Bindle runtime inference

**Property:** A Bindle retains every explicitly declared runtime and every OCI or Wasm runtime required by a resource or its dependency annotation. A generic HTTP handler alone does not impose OCI or Wasm. Losing a requirement can place work on an unsuitable host; inventing one can prevent a valid deployment.

**Review baseline:** commit `e27a2b9729128a08ba5465be1d7b68368d066841`. PASS for the bounded model, symbolic abstraction and generated tests below.

## Covered code

- `packages/bindles/src/dependencies.ts` collects OCI and Wasm requirements from resource kinds and recognized dependency annotations; `bindle.ts` infers the requirements and merges them with explicit declarations.
- `packages/bindles/test/bindle.test.ts` checks ordinary handlers, mixed OCI/Wasm dependencies, explicit declarations and dependency annotations. `packages/hobo/test/declared-runtime-binding.test.ts` checks 100 generated combinations of ordinary HTTP, OCI, Wasm and explicit local requirements (seed 614531).
- The embedded local-placement checks consuming these requirements live in `verify-yard-local-hosting`; this skill does not cover its authorization.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-bindles-runtime-inference
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on the model and view to inspect the transitions and any counterexample.

## Scope and evidence

`BindleRuntimeInference` explores 188 states with up to two resources, the three abstract kinds HTTP, OCI and Wasm, and all declared OCI/Wasm subsets. It checks both required runtimes, preservation of declarations and absence of invented runtimes. Its five-state projection hides 136 same-label steps. Six deliberately weakened model guards and six symbolic mutations produce counterexamples. Z3 reasons over arbitrary Boolean facts representing whether any number of resources need each host; the correspondence between those facts and the TypeScript collector is assumed, not proven.

The unmodified real tests are run by the skill. Seven optional real-code mutants can be replayed with `python3 .agents/skills/verify-bindles-runtime-inference/mutations/runtime.py`; the script first requires a passing control and checks for actual assertion failures rather than suite-loading errors. The model compresses recognized annotations into the corresponding resource kind; it does not prove arbitrary dependency parsing, provider capability matching, runtime availability or execution after placement.

To exercise the complete skill on broken real code, copy `packages/bindles` to a scratch package with linked `node_modules`, set `BINDLE_RUNTIME_VERIFY_PACKAGE_ROOT`, and remove either the explicit/runtime merge or one recognized dependency runtime. Confirm that the test failure is an assertion in `test/bindle.test.ts`, restore the source, then rerun the unmodified skill.

## Keep in sync

Read covered code and changes since the baseline. Update models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
