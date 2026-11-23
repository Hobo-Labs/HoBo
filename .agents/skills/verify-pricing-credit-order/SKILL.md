---
name: verify-pricing-credit-order
description: Check financial-source admission, credit selection, and economic basis when changing the pricing kernel.
---

# Pricing financial sources and credit ordering

**Properties:** A quote requires nonempty, distinct source IDs within each kind, matching tenant IDs, and agreement account references. It rejects any financial sources when agreements in the state name multiple provider accounts. For equal-priority, equal-expiry eligible credits, it selects independently of process locale and accounts for the consumed credit's basis. It rejects negative prices and source values, excess used plus remaining capacity, extra derived-credit basis, and consumption exceeding available basis.

**Why:** A duplicate $10 credit could be applied twice, foreign-tenant sources could be consumed, and a source with no account binding could be used across multiple accounts. Locale-dependent credit choice also produced $0 versus $9 effective cost for the same quote.

**Review basis:** commit `e9c20aea41e67c779a47d169e25de38ce28552fa`. Rerun checks against current source. The models and proofs do not establish that TypeScript refines them.

## Covered code

- `packages/pricing/src/{quote,state,catalog,rating,ordering}.ts`: financial-source validation, working-state ordering, rating, consumption and basis.
- `packages/pricing/test/pricing-source-identity.test.ts`: duplicate, foreign, missing, and multi-account source cases; same-account and no-source acceptance; 300 generated cases (seed 614485).
- `packages/pricing/test/pricing-source-values.test.ts`: amount, capacity, source unit and economic basis checks; 660 generated cases (seeds 614486 and 614487).
- `packages/pricing/test/pricing-locale.test.ts` and `test/fixtures/pricing-locale.mts`: cross-process locale tests and 300 generated credit permutations (seed 614482).
- `packages/pricing/test/golden-replay.test.ts`, `test/adversarial-10.test.ts`, and `contracts/consumer/quote-boundary.test.ts`: the pinned golden corpus and selected pricing and consumer boundaries.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-pricing-credit-order
```

The runner checks real TypeScript with Vitest and fast-check, TLC 1.7.4 models, expected counterexamples for weakened models, and Z3 4.15.4 arithmetic obligations. Java 11+, Python, Node, and installed workspace dependencies are required. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to pinned local installations for offline use. Use `/statechart` with the model and its corresponding view to inspect counterexamples and regenerate projections. Set `PRICING_VERIFY_PACKAGE_ROOT` to an isolated package copy for scratch mutations.

## Scope and evidence

The implementation tests reject duplicate or foreign allowances, credits, and commitments and reject unscoped sources in a state with multiple accounts. They accept multiple agreements for one account and multiple accounts with no sources.

PricingSourceIdentity explores 99 distinct states for three source kinds and present, tenant, uniqueness, and account-scope flags. It checks that accepted sources satisfy all four and that one abstract source cannot be counted twice. Removing any of the four guards violates its safety property. This abstraction starts with a financial source; account scope means all agreement account references are present and name at most one account. It assumes those classifications are correct. It cannot establish ownership or detect different IDs representing the same provider grant.

Z3 proves a unique, present, tenant-matched and account-scoped abstract source cannot contribute more than its balance when represented by an unbounded integer number of entries and a positive exact-real balance. Premises have a witness; `PRICING_IDENTITY_PROOF_MUTATION=omit-unique` and `omit-account` produce counterexamples. The obligation does not prove TypeScript refinement, external provenance, or the full pricing computation.

PricingSourceValues explores 852 distinct states for three source kinds, negative and excess balances, negative charges, limited basis, and derived credits. It checks nonnegative bounded debit, basis conservation, no additional derived basis, and monetary commitment units. Its smaller chart configuration explores 110 states. Removing any of the six modeled guards violates the corresponding property. Capacity abstracts the declared amount plus allowed rollover minus previously used amount; it assumes correct source-unit conversion and classification of gross charges and basis. It does not model all rate components, period changes, rounding, or actual provider ledgers.

Z3 proves that one arbitrary exact-real debit preserves nonnegative balances and basis and respects abstract remaining capacity; these obligations are inductive if the same assumptions hold before each debit. Premises have a positive witness; `PRICING_VALUES_PROOF_MUTATION=omit-capacity`, `omit-basis`, and `omit-derived` produce counterexamples. This is an abstract arithmetic proof, not a proof of TypeScript refinement, provider evidence, or proportional rounding.

PricingCreditOrder explores 8 distinct states for two hosts, two paid-credit basis values, and one complete use of one of two equal-priority credits. It checks conservation, basis attribution, and matching results across locales; making the choice locale-dependent violates the last property. The model assumes both credits are eligible and fully cover one use; it does not model partial consumption, rate cards, rounding, retries, temporal validity, or provider behavior. A separate Z3 obligation proves abstract balance conservation; `PRICING_CREDIT_PROOF_MUTATION=omit-debit` produces a counterexample.

The grant schema cannot bind a financial source to an account. Consequently quotes reject financial sources whenever any agreements in the state, including unused or inactive ones, refer to more than one account. This affects availability until account scope is represented. Even a single account's source, tenant, and account identifiers are supplied assertions; authoritative reconciliation remains necessary. Used and remaining are treated as belonging to the same grant and bucket. Quotes reject positive paid-credit rollover and commitment rollover or true-up because their carried basis or bucket semantics cannot be established from the current records. Temporal behavior is covered separately by verify-pricing-time.

## Keep in sync

When covered code changes, review source identity and account scope and credit order, run real-code checks and bounded models, replay counterexamples against code, try deliberately broken variants, regenerate charts, and advance the review basis only after confirming correspondence. Use `/maintain-formal-verification-skill`.
