---
name: verify-broker-quote-admission
description: Verify the general broker's quote-backed admission, current evidence checks, hold confirmation, receipt binding, and explicit legacy path.
---

# Broker quote-backed admission

**Properties:** In the checked quote-backed path, the policy gate and a newly confirmed hold receive the attested conservative liability for the selected work. The broker refuses untrusted or stale quotes, changes to the selected environment or catalog, and missing hold confirmation. It rechecks the quote after policy and after billing. The receipt carries the quote hash, work-binding digest and amount, and a configured signature covers them. Raw estimates require explicit host trust.

**Review baseline:** commit `3f0140e6b8fc1b1aeb4fe4b0b73368b16a1869e8`. PASS for the generated tests, bounded model and symbolic obligations below.

## Covered code

- `packages/broker/src/broker.ts` selects placements, freezes and hashes the work and host context, invokes `pricingAuthority`, checks the quote before and after the gate and hold, and signs the receipt when configured.
- `packages/broker/src/pricing-authorization.ts` checks exact quote liability and policy bounds. `packages/broker/src/metering.ts` supplies the default in-memory hold.
- `packages/broker/src/http.ts`, `types.ts`, and `data-models/broker.{proto,cue}` preserve pricing evidence and placements in the receipt. `packages/broker/src/local-host.ts` attests the built-in local provider's zero service fee only.
- `packages/broker/test/quote-admission.test.ts` runs 350 generated admissions (seed 614516), signed receipt and tamper checks, zero-value protobuf and HTTP round trips, and adversarial callback, environment, catalog, quote freshness and hold cases. `local-host.test.ts` checks the local quote and an external-provider refusal.
- `packages/hobo/src/broker-command.ts` composes local pricing or host-provided pricing; its tests cover explicit legacy compatibility and a registry refusal without an authority.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-quote-admission
```

The runner checks checksum-pinned TLC 1.7.4. Set `TLA2TOOLS` to the jar and `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or allow the runner to obtain them. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` on the model and view to regenerate the user-flow projection.

## Scope and evidence

The model treats quote authentication, the bound's conservatism, policy decisions, and the billing plane's hold confirmation as trustworthy predicates. It checks transitions from selection through gate, confirmation, post-hold evidence checks and issuance; stale evidence, a changed approved environment or catalog, and absent hold confirmation refuse the modeled resolution. The `checkedFresh` property refers to the last check, not a guarantee that time cannot pass or evidence cannot change afterward. Delivery and execution are not modeled. The model does not prove cryptography, actual provider charges, concurrent processes, external policy changes, persistent holds or refinement of the TypeScript implementation.

TLC explores 108 states. The chart has seven states and nine arrows and hides 140 same-label steps. Five deliberately weakened model guards produce counterexamples for stale quotes, absent holds, an omitted bound, environment changes and catalog changes. Real-code examples replay these paths: a quote expires during billing, a billing response omits hold confirmation, gate/billing receive the host bound, and environment or catalog changes during a callback. The post-check freshness window remains a separate delivery and execution concern.

Z3 checks the final guards over arbitrary modeled nonnegative exact-real values: the gate and hold cover the bound, the bound covers the quoted bill, and it fits the cap and budget, under the trusted evidence predicates. A satisfying witness rules out vacuity; removing each of six guards produces a counterexample. This abstraction does not prove IEEE rounding or source integrity; those are checked separately by `verify-broker-quote-provenance`.

The default billing plane is process-local and loses holds on restart. A custom plane's confirmation is trusted, and a newly created hold may remain if the plane lacks or fails release. Host attestation must establish source, work binding, current evidence and a conservative bound. Signatures are optional. HTTP delivery now requires a matching receipt issued by the same broker instance, but it does not authenticate the caller or enforce a signature; see `verify-broker-delivery-claim`. The local-host authority excludes infrastructure and third-party charges. Guest requests fail closed. Yard-first hosting has its own path and is not covered here.

For implementation mutation, copy `packages/broker` to a scratch package with its `node_modules` linked, set `BROKER_ADMISSION_VERIFY_PACKAGE_ROOT` to that package, and remove the final quote recheck or restore the old broker. The real-code test must fail. Restore the source and rerun the skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline, update the model and implementation checks, replay counterexamples, run broken scratch variants and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
