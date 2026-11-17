---
name: verify-broker-quote-provenance
description: Verify the trusted quote-attestation and conservative liability boundary when changing broker pricing authorization.
---

# Broker quote provenance and liability

**Properties:** Quote authorization requires an intact eligible quote and a host attestation. The attested liability must cover the quoted bill and fit the original cap and budget. The host must explicitly trust a legacy raw estimate. Changing the quote during attestation or changing the caller's policy object during the callback cannot alter the approved work or bounds. A self-hashed quote previously needed no independent authority, and the expected bill was treated as the liability bound.

**Review baseline:** commit `52fc736200906e09c7e1493d747e41edf83d1496`. PASS for the generated tests, bounded models and symbolic obligations below.

## Covered code

- `packages/broker/src/pricing-authorization.ts` copies and validates quotes, requires `attestQuote`, checks the host's exact liability bound, snapshots billing limits, and requires `trustEstimate: true` for raw estimates.
- `packages/broker/src/billing-decimal.ts` and `packages/pricing/src/decimal.ts` provide decimal conversion, comparison and conservative numeric output. `packages/broker/src/rejections.ts` catalogs the quote rejection codes.
- `packages/broker/test/quote-provenance.test.ts` checks a signed request-bound host-attestation example, forged and stale attestations, missing or inadequate bounds, callback exceptions and mutation, and 500 generated quote/liability/cap cases (seed 614515). `pricing-authorization.test.ts` supplies an explicitly trusted test authority and checks the existing quote rules and 300 generated cap cases.

## Run

From the repository root after installing and building workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-quote-provenance
```

The runner checks checksum-pinned TLC 1.7.4; set `TLA2TOOLS` to that jar or let it download it. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` to read both models and their views.

## Scope and evidence

`QuoteProvenance` explores 64 states for quote or legacy input, validity, host attestation, mutation and explicit estimate trust. The projection draws eight states and six arrows and hides 32 same-label steps. The old behavior accepts a quote without attestation and a raw estimate without explicit trust. A mutated variant also accepts changed content; real-code tests reject callback and getter mutations.

`QuoteLiability` explores 162 states for bounded quote amounts, attested liabilities and original and later caps. It checks that accepted liability covers the quote and the authorized amount fits the original cap. The projection draws five states and three arrows and hides 81 same-label steps. The old quote-amount comparison and a variant that reads a changed cap both produce counterexamples. Real-code tests cover insufficient and over-budget bounds and a callback that changes the caller's policy object.

The Z3 obligations hold over arbitrary modeled nonnegative exact-real values and the stated authentication and budget guards. Every premise has a witness; removing attestation, mutation, bound, original-policy, budget or legacy-trust guards gives counterexamples. They do not prove that the host callback authenticates a source, verifies signatures, binds the quote to actual work, proves the bound conservative, checks freshness, or implements TypeScript refinement. The signed test is an example host verifier, not a production trust enrollment. The helper calculates an authorization amount; it does not create a durable hold. The general broker invokes this helper with a host pricing authority unless the host explicitly opts into legacy estimates; see `verify-broker-quote-admission` for that integration.

Callers must migrate to `attestQuote` backed by trusted, correctly scoped evidence and return a conservative USD bound. `trustEstimate: true` is an explicit compatibility mode that trusts the caller's estimate; use a durable authority for holds and final settlement.

For a scratch mutation, copy `packages/broker` to a temporary package directory with linked `node_modules` and the pricing corpus at its expected relative path. Set `QUOTE_PROVENANCE_VERIFY_PACKAGE_ROOT` to that copy and restore the earlier authorization code, or remove the policy snapshot. The real-code checks must fail. Restore the code and rerun the skill.

## Keep in sync

Review covered code and uncommitted work since the baseline. Update models and implementation tests for intended changes, replay counterexamples against code, run deliberately broken scratch variants and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
