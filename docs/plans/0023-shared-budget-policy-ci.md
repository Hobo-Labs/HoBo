---
type: Implementation Plan
title: "Shared budget policy and CI admission"
description: "Implementation and adversarial scenario record for the common hosting/CI budget language and shared durable financial admission."
tags: [hobo, budget, ci, hosting, implementation, resilience]
---

# Shared budget policy and CI admission

Design authority: [shared-budget-policy.md](../design/shared-budget-policy.md).
This extends the completed hosting design into CI policy authoring, selection,
durable admission, provider effects, recovery and settlement.

## Implemented work

- Core: generated shared policy, CUE, strict JSON, canonicalization, scoped keys,
  explicit monetary presence and pure planning/admission evaluation.
- Hosting/bundles: canonical policy preservation, trusted policy identity,
  objective propagation, complete bound evaluation and durable evidence replay.
- Broker: shared SQLite/PostgreSQL authority, retired-period and removed-bucket
  history, atomic unused release and sequence-fenced execution claims.
- CI: explicit objectives, current durable policy, immutable payers, admission
  generations, queue deadlines, native usage/reconciliation and parent receipts.
- CI GitHub/Station: scoped signals, guarded dispatch, current policy around
  awaits, project-file authoring and truthful inspection.

## Executable scenario ledger

Paths identify actual source suites; provider-shaped expectations remain separate
from native vendor acceptance.

| Failure or adversarial case | Regression evidence |
| --- | --- |
| Unknown controls, duplicate/escaped JSON keys, omitted zero limit, unsafe money, unit mismatch | `packages/core/test/budget-policy.test.ts`, `budget-policy-schema.test.ts` |
| Same shared policy lost or weakened in a hosting manifest, planner input or replay | `packages/bindles/test/manifest/budget-policy.test.ts`, `packages/cloud/test/hosting-shared-budget-policy.test.ts`, `packages/hobo/test/hosting-shared-budget-policy.test.ts` |
| Cheap partial free allocation costs more overall; repricing uses the wrong objective | `packages/ci/test/routing.test.ts`, CI policy tests and both CI-GH relay suites |
| Stale caller account bypasses cap/pause; policy changes immediately before native open | CI execution/admission regression suites and scheduler tests |
| Offer/account aliases refill allowance; same-period usage watermark decreases | CI configuration/store/history regression suites |
| Removed credit bucket or retired period is revived after reopen | `packages/broker/test/budget-authority-history.test.ts` |
| Protobuf metadata leaks into scoped signal JSON | `packages/broker/test/budget-signal-wire.test.ts` |
| Old reset/recovery affects current budget; zero budget; runtime enablement overwritten | Scoped CI/Station signal suites and executed scoped-signal Pact |
| Parent hold commits before CI lease; replay funds another attempt | Actual SQLite CI composition and real PostgreSQL store tests |
| Hosting and CI concurrently reserve against one shared balance | `packages/hobo/test/hosting-postgres-budget-authority.test.ts`, `packages/ci/test/shared-budget.test.ts` |
| Cheapest offer exhausts parent credits; unknown commit is mistaken for safe fallback | `packages/ci/test/parent-offer-fallback.test.ts` across SQLite pipelines, SQLite runners and PostgreSQL runners |
| Safely canceled job cannot be repriced; a crash incorrectly increments its funding attempt | CI shared-budget/store generation tests |
| Cancellation lookup races execution claim; stale claim passes after another financial write | Broker independent-connection SQLite and PostgreSQL tests; CI shared-budget tests |
| Native quote bound exceeds planner estimate or a narrower per-work ceiling | CI shared-budget/store actual-bound tests |
| Larger native liability bypasses a tighter local cap or undercounts the next hold | `packages/ci/test/shared-budget-liability.test.ts` |
| Credit claim omits a free dimension or understates quantities | CI shared-budget allocation coverage tests |
| Queue expiry during awaited reads or after financial claim | Both CI-GH relay suites; no provider call and retained uncertainty |
| Native command succeeds but financial observation fails; restart reruns command | CI execution observation/reconciliation regression suites |
| Stop acknowledgment or elapsed wall time is mistaken for final billing | CI scheduler/shared-budget usage and receipt tests |
| Claimed cancellation is released without native proof, or native identity is rebound on retry | `packages/ci/test/native-usage-finality.test.ts`, `packages/ci/test/sqlite-shared-store-composition.test.ts` |
| Different job receives the shared runner label | Local/hosted relay tests preserving whole-host financial exposure |
| Database pool starvation, row-lock stall, statement stall, lost successful COMMIT reply | Real PostgreSQL shared-authority tests |
| Project JSON/editor/SDK/control path drops common intent or displays a looser cap | CI-GH project policy, CLI and actual HTTP/SQLite reopen suites |

## PR self-review repairs

Independent review reproduced native pipeline allocation at the exact persisted
queue deadline after asynchronous preflight. Both ordinary and native execution
authorization now reject that boundary before provider effects.

Restricting execution to a selected offer had also removed other offers from
provider-cost constraint measurement. Candidate restriction now preserves those
offers as disabled accounting context, including held-lease checks in SQLite,
PostgreSQL and both GitHub Actions relays. A legal multi-provider policy can execute
without weakening its other account constraints.

GitHub Actions preflight now evaluates planning intent with trusted attempt/queue
metrics. Durable admission and execution claims still enforce strict native proof.
Executed local/hosted relay regressions use the real SQLite financial authority;
withdrawing native proof after reservation produces no provider dispatch.

Related hosting/provider repairs are recorded in the
[hosting review record](0022-budgeted-cloud-hosting-transitions.md#pr-self-review-repairs).

Integrating main exposed a schema-fixture ownership conflict. CUE corpora can now
be scoped to their schema while legacy flat corpora retain every existing check;
the Hobo composition fixtures use that scoped layout. Real CUE negative controls
verify that schema mismatches and incorrectly accepted invalid inputs still fail.

Native compilation acceptance also reproduced a runner issue: Vite transformed
the installed TypeScript compiler. The CLI and Hobo test configurations now load
that dependency through Node, preserving workspace source transformation and Hobo
test isolation. The five failing compiler cases passed with their original
30/60/90-second limits. Compiler/process suites bound file-level concurrency while
retaining within-test races. Site and CI-GH tests honor the existing bounded machine
timeout override; CLI/provider operation guards and financial assertions remain
unchanged.

## Pre-PR validation record

The frozen implementation passed `pnpm run agent:check -- --staged --base=HEAD`:
**17 relevant checks passed**, including all eight affected package suites and
their dependency builds. The run used Node 24, pnpm 10.33.4,
`VITEST_MAX_WORKERS=1`, `HOBO_TEST_TIMEOUT=60000` and
`HOBO_RELEVANT_CHECK_CONCURRENCY=2`. `HOBO_TEST_POSTGRES_URL` pointed to an isolated
local PostgreSQL 18.3 server, so the native PostgreSQL cases executed.

| Affected package | Passing tests |
| --- | ---: |
| Core | 969 |
| Broker | 526 |
| CI | 214 |
| CI GitHub Actions | 559 |
| Cloud | 608 |
| Bindles | 272 |
| Stations | 221 |
| HOBO | 1,562 |
| **Package total** | **4,931** |

The same gate passed 290 root tests, 48 bounded property tests and 124 schema
manifest/stage-gate tests. CUE validation parsed and resolved **922 files across
870 package groups**. Architecture, generated/editor schema regressions,
TypeScript builds, frozen dependency installation, Biome, strict changed-file
Oxlint (175 TS/JS files), package conventions, technical standards, licenses,
documentation and design checks passed.

Actual PostgreSQL acceptance covered independent connections competing for one
hosting/CI balance, durable reopen, rollback, lost successful COMMIT replies,
claim fences, post-await clock expiry, bounded pool/lock/statement waits, and
parent-aware offer fallback. SQLite acceptance used real durable stores and
independent connections. The project authoring path exercised real loopback
HTTP, generated JSON, SDK/control translation, reopen and journal replay.

These results certify the exercised software contracts. Paid CI vendor execution
and live vendor billing were not performed. Strict admission requires a trusted
provider-native liability bound and rejects missing proof; authored policy or a
timeout cannot manufacture that guarantee. Concurrency metrics cover the owning
admission partition, and shared runner labels retain repository-wide financial
exposure, as described in the design authority.

## Final PR validation

After integrating main and completing the independent review repairs, the normal
commit hook passed **all 24 relevant checks**. The final affected workspace graph
completed **120/120 Turbo tasks**. Package-scoped runs established successful
results before the final hook reused their unchanged results.

| Final affected scope | Passing tests |
| --- | ---: |
| Core, Broker, CI, CI GitHub Actions, Cloud, Bindles and Stations | 3,465 |
| 18 provider SDK workspaces | 4,884 |
| CLI | 546 |
| HOBO composition | 1,628 |
| Schema tools | 214 |
| Dispatcher | 195 |
| Site | 109 |
| FinOps epic proof | 34 |
| **31-workspace total** | **11,075** |

Additional checks passed: **105 behavior scenarios / 486 steps**, 290 root tests,
48 bounded property tests, 124 schema manifest/stage-gate tests, generated protobuf
drift and CUE fixture validation, 922 CUE files across 870 package groups, Site
typechecking, architecture, strict changed-source lint, proof artifacts/cascade,
documentation/design, license and traceability checks. Frozen installation passed
with pnpm 10.33.4. PostgreSQL 18.3 acceptance used an actual isolated local server.

The final package runs used Node 24, `VITEST_MAX_WORKERS=2` and
`HOBO_TEST_TIMEOUT=60000`. CLI/HOBO configuration bounds file-level compiler/process
acceptance while retaining isolation and concurrent operations inside individual
tests. Compiler acceptance kept its original 30/60/90-second limits. The complete
CLI suite passed in 269.13 seconds; HOBO passed in 550.26 seconds. No paid provider
operation was used for this validation.

The exact staged public patch was also compared against 56 private values from
anonymous acceptance evidence: **618 files checked, zero matches**. Private native
credentials and bearer identities remain outside the checkout.

PR-base standards review also checked public wire/API constants individually.
Their contract annotations remain adjacent to each declaration, including retained
compatibility environment names and diagnostic provider URLs; that repair changes
comments only.
