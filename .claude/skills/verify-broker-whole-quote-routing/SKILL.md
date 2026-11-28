---
name: verify-broker-whole-quote-routing
description: Verify complete-quote plan ranking, safe budget fallback and pricing authority rechecks in the general broker when its placement, admission or delivery code changes.
---

# Broker whole-quote routing

**Properties:** The quote-backed broker refuses an incomplete search, selects the lowest quoted total among affordable enumerated plans, retries a budget denial only when the billing plane confirms no reservation or external effect, and refuses a change to the authority object or its callbacks before a receipt or dispatch. If any rule fails, work can be routed to an unnecessarily expensive provider, a budget can be exceeded, or untrusted pricing can authorize a deployment.

**Review baseline:** commit `3557d0c3f1d9937d40f96caa9ec9857d080d00c6`. PASS for the bounded models, symbolic abstraction and generated tests below.

## Covered code

- `packages/broker/src/broker.ts`: `placementChoices`, `enumeratePlans`, quote and attestation callbacks, exact quoted-total sorting, gate/billing fallback, authority rechecks and delivery. The hard search bound is 128 complete combinations of eligible definitions and regions. Every plan needs an eligible, host-attested quote; static budget/cap denials may be excluded only after evidence validation.
- `packages/broker/src/metering.ts` and `planes.ts`: the default hold accounts for existing exposure and declares `noReservationCreated` only for a budget or cap denial before a new hold; a custom billing plane must make the same guarantee. Policy denial or approval is not bypassed.
- `packages/broker/src/policies.ts` and `data-models/broker.cue`: duplicate resource IDs reject in both runtime parsing and the CUE contract. The CUE test checks a valid and an invalid request.
- `packages/broker/test/whole-quote-routing.test.ts` checks multi-resource and region combinations, missing and ineligible quotes, mixed marginal units, the exact 128-plan boundary, existing holds, unsafe denials, catalog and authority changes, policy approval and duplicate IDs. Generated tests compare 180 static-budget and 120 existing-hold cases to independent integer references (seeds 614520 and 614521). `quote-admission.test.ts`, `default-billing-holds.test.ts` and `delivery-authorization.test.ts` cover the supporting checks, including authority replacement inside final delivery attestation.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-whole-quote-routing
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4; set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. The CUE check needs `HOBO_CUE_BIN` or `cue` on PATH. Node, Java 11+, Python, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on each model and its view to inspect the transitions and any counterexample.

## Scope and evidence

`WholeQuoteSearch` explores 306 states for two candidates, costs and bounds in 0..1, a cap in 0..1, and abstract complete-evidence, bounded-search and unique-ID flags. It checks complete evidence, the search bound, unique IDs, the selected cap and the cheapest eligible total. The four-state projection hides 144 same-label steps. It abstracts enumeration and evidence authentication as a single scan; it does not prove the catalogue is complete or the host is truthful.

`WholeQuoteRetry` explores 42 states for two already ordered candidates, one abstract policy decision, fixed available budget and a safe-denial flag. It checks policy refusal, fit, first affordable selection and that an ambiguous denial cannot lead to another attempt. The five-state projection hides 16 same-label steps. The real code evaluates the gate for each candidate; a later denial stops the search. The model assumes the billing result and the no-reservation marker are honest.

`AuthorityRecheck` explores six states for a single authority or callback change before receipt issuance or delivery. Its six-state projection hides two same-label steps. It checks that receipt and dispatch were created while the modeled authority was current. The model abstracts callback changes as a step before the last check. The implementation detects changed object and method references at its checkpoints; it cannot detect changed closure state, a change that is undone between checks, or revocation after dispatch. The host must make each attestation reflect current evidence.

Z3 proves the ranking and fit obligations for an arbitrary finite number of plans and exact-real amounts, assuming sorted truthful complete quotes, fixed limits, honest denials and all earlier candidates unaffordable. It checks separate non-vacuous first-choice and fallback witnesses. It does not prove the TypeScript implementation refines this abstraction, authenticate provider liability, establish durable holds, or prove liveness. Ten weakened TLA+ guards and six weakened Z3 premises yield counterexamples. The real-code tests replay missing evidence, wrong cost ordering, unsafe retry, omitted bounds, duplicate IDs and authority replacement.

Examples of the guarded failures: a cheap marginal-price provider can have the more expensive whole quote; an unsafe denial may have created a hold, so retrying can commit twice; a host callback can replace its authority while the broker is checking evidence. The real-code regression tests must refuse or select correctly in each case.

For implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_WHOLE_QUOTE_VERIFY_PACKAGE_ROOT`, and remove the whole-total comparison or another guard. The real-code checks must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review all covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and run the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
