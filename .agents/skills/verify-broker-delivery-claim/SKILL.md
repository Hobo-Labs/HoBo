---
name: verify-broker-delivery-claim
description: Verify process-local receipt provenance, quote rechecks and at-most-once broker delivery when changing resolution or delivery.
---

# Broker delivery and resolution claims

**Properties:** Within one broker instance, a request identity has at most one issued receipt even with concurrent resolutions. Delivery accepts only an unchanged receipt issued by that instance, claims it before invoking host callbacks, rechecks the quote and context, and submits at most once. A submission error leaves the attempt claimed because the remote outcome may be unknown. Failures before submission can be retried; the budget hold is not released.

**Review baseline:** commit `3f0140e6b8fc1b1aeb4fe4b0b73368b16a1869e8`. PASS for the generated histories, bounded models and symbolic obligations below.

## Covered code

- `packages/broker/src/broker.ts` serializes resolutions by request identity, records issued receipt snapshots, checks identity and pricing before delivery, and keeps a claim after submission starts.
- `packages/broker/src/http.ts` parses delivery receipts; the broker checks that the resulting content matches its issued copy. `packages/broker/src/planes.ts` reports transport failures as potentially ambiguous.
- `packages/broker/test/delivery-authorization.test.ts` checks forged and foreign receipts, expired quotes, changed context, callback reentrancy, concurrent resolutions and deliveries, post-submission uncertainty, immutable delivery copies, misleading transport advice, and 250 generated delivery histories (seed 614517). `quote-admission.test.ts` checks the underlying pricing and receipt path.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-delivery-claim
```

The shared runner checks checksum-pinned TLC 1.7.4. Set `TLA2TOOLS` to that jar and `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or allow the runner to obtain them. Java 11+, Python with pip, Node, Vitest, fast-check, and built workspace dependencies are required. Use `/statechart` with each model and its view to regenerate the diagrams.

## Scope and evidence

`BrokerDelivery` explores 23 states and checks that only an authentic, fresh, context-matching receipt is dispatched, at most once, and that no dispatched attempt returns to ready. The projection has five states and five arrows and hides 30 same-label steps. `BrokerResolutionClaim` explores 12 states for two concurrent or sequential requests with the same identity; it checks at most one receipt. Its projection has three states and three arrows and hides seven same-label steps. Six weakened model guards produce counterexamples, and implementation tests reproduce the corresponding forged receipt, expired quote, changed context, retry, concurrent resolution and issued-replay cases.

Z3 induction proves the single-process modeled delivery count and claim invariant over arbitrary integers satisfying its premises; the separate Boolean guard implications require authenticated, current evidence. Every premise has a witness. Removing retry, origin, freshness or context guards yields counterexamples. The abstract proof is not a proof of TypeScript refinement, trusted host callbacks, clock synchronization, receiver behavior or persistent storage.

The issued receipt registry and claim are in memory. A restart forgets them and refuses old receipts; there is no durable reconciliation API for ambiguous submissions. Independent broker processes can still issue and deliver independently. A matching receipt proves only that this process issued that content: it does not authenticate the caller. Quote freshness is checked immediately before handing the request to the delivery plane; a delayed remote receiver can execute later, after expiry or revocation. Signatures remain optional and the host attestor, billing plane, provider costs and remote effects remain trust boundaries. These limitations require separate durable and receiver-side enforcement.

For implementation mutation, copy `packages/broker` into a scratch package with linked `node_modules` and set `BROKER_DELIVERY_VERIFY_PACKAGE_ROOT`. Restore the previous broker implementation, remove the delivery claim, omit the final quote check, or remove the in-flight or already-issued resolution guard. The real-code tests must fail. Restore the implementation and rerun the skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update both models and actual-code histories, replay each counterexample, run broken scratch variants and then the unmodified skill, and advance the baseline only after confirming correspondence. Use `/maintain-formal-verification-skill`.
