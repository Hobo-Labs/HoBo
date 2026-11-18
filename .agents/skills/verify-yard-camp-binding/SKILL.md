---
name: verify-yard-camp-binding
description: Verify that Yard-first placement preserves the requested Camp environment and cannot approve a Camp outside the selected Yard.
---

# Yard Camp binding

**Property:** Yard-first placement snapshots the requested Camp environment, preserves an explicit Camp identity, and issues a placement only for a direct child of the selected Yard after host authorization. A known foreign Camp is refused before a quote or generation hold and provider effect. An exact Camp request requires an ID before quoting or authorization. Malformed environment and Camp input is refused. Otherwise an exact request can silently select a default Camp, a receipt can name a Camp in another Yard, or an unnecessary Yard can be provisioned.

**Review baseline:** commit `92c291c26b58af86b169c0fb51aa6211f7c0f775`. PASS for the models, symbolic obligations and real-code checks below. Special JSON key preservation is checked separately by `verify-yard-json-constraints`, and residency preflight by `verify-yard-residency-validation`. The separate `verify-yard-camp-constraints` skill checks refusal of unverified Camp and nested-layout constraints.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts`: `parseBindleDeploymentRequest` requires an ID for exact Camp selection, validates Camp input via `validateRequestedCampLayout`, uses `parseCampLayout` and snapshots it before authorization; `selectOrGenerateCamp` preserves an explicit identity or constructs `camp:<envType>` (default `dev`), and refuses a qualified identity outside the selected Yard. The request-validation skill covers the additional estimate and constraint checks. `prepareYardHostingWork` refuses a foreign Camp before quoting; `resolveBindleDeployment` checks it against the planned Yard before generation admission and again against the selected Yard afterward. A mismatch after a prior generation uses the existing uncertainty path.
- `packages/broker/src/yard-placement/types.ts`: `parseCampLayout` preserves `id`, `env`, `envType`, requirements and labels and returns frozen values.
- `packages/broker/test/yard-camp-binding.test.ts`: real placement tests cover production, default and explicit Camp IDs, foreign and nested IDs, invalid input, source mutation during authorization, and 30 generated environment names (seed 614534). They also check that changing only the Camp environment changes the quote's work digest and that a foreign Camp is not quoted. `yard-exact-camp.test.ts` exercises missing and explicit exact IDs, quote and authorization refusal, compatible defaulting, and 100 generated layout IDs (seed 614585). `yard-event-store-folds.test.ts` supplies a previously issued quote for a foreign Camp and checks that neither a hold nor a provider effect occurs. Parser and Yard placement suites run alongside them.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-camp-binding
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to installed copies, or let it obtain them. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardCampBinding` explores 185 states and 299 steps for three environment cases, five Camp identity classes, an allow or deny decision, and caller edits after parsing. It checks preserved environment, malformed-input refusal, Yard containment, explicit-ID precedence, correct generated environment and host approval before a receipt. The six-state projection has seven arrows, hides 60 same-label steps and suppresses 114 caller-edit steps. It assumes a ready Yard has already been selected; host approval and the financial authority are abstract predicates, not implementations. `YardCampGeneration` explores 14 states for planned and actual Yard matches, a financial hold, provider effect and post-generation refusal. Its seven-state projection hides four same-label steps; it assumes the uncertainty write succeeds, and overapproximates which Yard a rematch may select. `CampExact` explores 28 states for exact and compatible requests with and without an ID, across quote and deployment routes. Its seven-state projection has eight arrows and hides eight same-label steps.

Ten weakened model checks yield counterexamples. Z3 checks six string-construction obligations for arbitrary Yard, Camp and environment strings under the listed guards, and four weakened guards produce satisfiable counterexamples. This symbolic abstraction does not prove that TypeScript refines the model. Eight real-source mutants can be run with `python3 .agents/skills/verify-yard-camp-binding/mutations/runtime.py`; each first requires a passing control and then an assertion failure, not a test-loading error.

Camp existence, full selection-mode semantics, capability and runtime matching are not established by this skill. A name under the Yard is not evidence that the Camp exists or satisfies its requirements. The post-generation mismatch model assumes the existing uncertainty write succeeds; other covered generation failures and failed writes are checked by `verify-yard-funded-admission`. The separate `verify-yard-request-wire` skill checks the request codec. Provider effects, general durable hold semantics, actual transport and receiver execution require separate verification. A caller changing its input during the synchronous initial clone is outside the model.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_CAMP_VERIFY_PACKAGE_ROOT`, and replace the foreign-parent refusal with `return campId`. The real Camp test must fail on an assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
