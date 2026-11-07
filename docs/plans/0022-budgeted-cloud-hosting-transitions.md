---
type: Implementation Plan
title: "Budgeted cloud hosting transitions"
description: "Effects- and resilience-aware remediation of core cloud placement, reservations, cutover and settlement scenarios discovered in the adversarial walkthrough."
tags: [hobo, hosting, finops, implementation, effects, resilience]
---

# Budgeted cloud hosting transitions

Design authority: [hosting-budget-transitions.md](../design/hosting-budget-transitions.md).
Scope is budgeted cloud hosting placement, deployment, movement and decommission
across approved platforms, including concrete provider execution and evidence.

## Work and ownership

1. Dispatcher: hard feasibility, complete reservations, idempotency, capacity,
   expiring credits and actual sustained savings evidence.
2. Broker: period/revision budget identity, current financial observations,
   Yard-first quote/admission integration and explicit zero/unlimited semantics.
3. Cloud Planner/gateway: normalized bounded quotes, shared entitlements,
   total plan commitment, tenant-authoritative evidence and reservation before activation.
4. Station loop/cutover: serialized durable state, recovery over cooldown,
   preserved constraints, mandatory evidence and observed rollback.
5. Cloud durable hosting transition: generated records, EffectSpec and
   ResilienceProfile boundaries, atomic intent/outbox/timer, bounded reconciliation,
   stateful ownership evidence, source retirement and financial settlement.
6. FinOps epic proof: actual requirement checks, governed metric evaluation,
   stable normalization, feasible incumbent stability and honest snapshot provenance.
7. Provider execution: native registries, durable mutation and resource custody,
   pinned credential leases, signed financial evidence, independent serving checks,
   explicit liability bounds and anonymous acceptance where supported.

## Rubber-duck invariants

- A decision that explains a budget cannot bypass the authority owning it.
- A score cannot repair missing capabilities, financial evidence or write ownership.
- A successful provider request does not prove the desired state was realized.
- A lost response does not prove the request failed.
- Compensation is an external operation with its own possible failures.
- A traffic change does not prove a hosting charge ended.
- Replay reconstructs state and never repeats external effects.
- A timeout, cancellation or period reset cannot erase an unresolved liability.

## Validation

First reproduce each reviewed failure as a negative behavioral test. Run package-scoped
tests and typechecks before affected integration and schema/contract checks. Validate
generated records, CUE fixtures, Pacts, executed proof examples and Gherkin, architecture,
documentation and technical standards. Finish with an independent adversarial review of
the complete hosting path and a scenario-to-test ledger. Record exact results and any
environment limitations; do not label metadata or mocked tests as live-provider evidence.

## Progress

- Design, implementation and independent adversarial review completed.
- Existing effects/resilience contract reuse checked against its actual enforcement.
- Offline validation exercises local adapters and durable stores. Live provider acceptance
  remains an explicit manual profile.

## Core validation record — 2026-10-29

The final affected-change gate passed all 21 selected checks.

Full workspace suites passed under their owning package configuration:

| Workspace | Passing tests |
| --- | ---: |
| Bindles | 259 |
| Broker | 493 |
| Cloud | 512 |
| Dispatcher | 195 |
| Hobo composition | 1,442 |
| Schema tools | 210 |
| Stations | 221 |
| FinOps epic proof | 34 |
| Total | 3,366 |

Additional validation passed: 290 root tests, 48 bounded property tests, 105 offline
Cucumber scenarios / 486 steps, generated protobuf drift checks, 913 CUE files across
870 package groups, positive/negative CUE corpora, consumer contracts, strict proof
typechecking, package builds, executed example/notebook artifacts, architecture,
changed-source lint, documentation, licence and traceability checks. The frozen
lockfile install passed with the repository-pinned pnpm version.

Independent review added regressions for omitted allocations, an adopted hold funding
a different artifact, zero-cash period rollover, provider-account watermark removal,
post-authorization expiry/adapter changes, cancellation recovery, foreign status/acks,
stale restart health and checkpoint CAS advancement. The CLI-wide run also exposed and
fixed a leaking fetch fixture and a catalog fixture comparing incompatible compute units.
Traffic proofs now observe a minimum request count at each phase instead of assuming
throughput from elapsed time.

The live Cloudflare scenario provisions a public worker and now has an explicit
`live-cloudflare` Cucumber profile, consistent with the repository's manual-only rule
for external services. Discovery was validated with `--dry-run` (one scenario / eight
steps); live provisioning, billing and migration were not executed. A prerequisite
build and IPv4/IPv6 mismatch were diagnosed while separating that lane. A leftover
untracked dependency-only `pixel-village` directory was moved outside the repository's
package discovery so the structure gate validates real packages.

Integration requires a durable shared authority, trusted quote and settlement resolvers,
a conformant execution adapter and Station persistence using `expectedStateVersion`.
The initial planner remains greedy: it can refuse a request that a different allocation
could fund. Missing bounds or evidence continue to refuse admission.

## Provider expansion — 2026-10-30

The [production provider design](../design/hosting-provider-production.md) records the
expanded implementation, each provider's role and actual anonymous acceptance. It
supersedes the core record's statement that live provisioning had not run. Direct
shipped anonymous SDK acceptance provisioned Cloudflare, Neon, Upstash, Prisma, Netlify
and Lakebed without permanent account credentials. The Cloudflare Cucumber profile is
still an independent manual lane.

Production composition now includes native registries, durable allocation/mutation
custody, version-pinned credentials, signed financial/native lifecycle evidence and
explicit source/destination operating liabilities. Missing enforceable bounds refuse
new effects. Routing success and timer expiry cannot release unresolved funding.

Live acceptance established Cloudflare HTTP plus confirmed worker deletion, Neon SQL,
Upstash Redis PING, Netlify authenticated temporary-site HTTP and Lakebed native read
plus health. Prisma creation succeeded but a later SQL probe failed; health and cleanup
are unconfirmed. Other temporary services' retirement remains unconfirmed until observed.
No paid-provider live acceptance is claimed.

The generic Cloudflare registry was additionally exercised with the actual durable
mutation journal. Native multipart source readback, explicit subdomain activation,
serving HTTP 200 and confirmed worker absence passed; deletion was independently
observed at 2026-10-30T01:04:30Z. Anonymous database native IDs and allocation UUIDs
are treated as bearer capabilities: private HMAC keys derive operation identities,
and public receipts/facts require custody and expose opaque identities.

## Provider validation record — 2026-10-30

All 29 affected workspace suites passed **9,990 tests**. The final workspace run
completed **115/115 Turbo tasks**, reusing unchanged successful results. This includes
1,557 Hobo composition tests, 916 core tests, 585 Cloud tests, 538 CLI tests and 109
Site tests; the Site production build and typecheck also passed.

Additional checks passed: 290 root tests, 48 bounded property tests, 105 offline
Cucumber scenarios / 486 steps, 921 CUE files across 870 package groups, generated
protobuf drift checks, native schema corpora, architecture, strict changed-source
lint, proof artifacts/cascade, documentation, design lint, licenses and traceability.
The frozen lockfile install passed with pnpm 10.33.4. The explicit manual harness's
four SQLite/local-HTTP fault tests and strict standalone compilation passed.

The affected gate selected 24 checks. Its workspace tasks all succeeded; the combined
command returned nonzero for two missing public-contract annotations. Those comments
were added and the complete staged standards check then passed. Only comments and this
validation record changed after the workspace pass. The final documentation and lint
checks cover that repair; the runtime suites were not repeated for comments.

Integration failures found during this gate were corrected and rechecked: Cloudflare's
explicit Workers product identity now appears in the canonical golden plan; legacy
drift fixtures explicitly store undecided plans and assert zero network requests;
catalog fixtures supply independent native multipart source readback and verify
sanitized credential failures without leaked causes. Live provider boundaries remain
those in the production design; no authenticated provider was live-certified.

## PR self-review repairs

An independent review reproduced a paid Yard provisioning race: cancellation
could release an unclaimed financial hold while the connector provisioned. The
Broker now sequence-fences an execution claim before provider I/O, rechecks expiry
after claiming, and observes an identical claimed retry instead of provisioning
again. Actual independent SQLite connections exercise the cancellation race.

Routing now rechecks cancellation and the trusted deadline after awaited credential
verification, immediately before SHIFT/RESTORE I/O. Cutover health dwell starts
after confirmed native realization; a recovered uncertain operation persists a
fresh observation baseline. Delayed authorization and slow provider replies cannot
satisfy the dwell period. Authoritative CLI planning also preserves the authored
common objective, matching deployment.

Provider review repaired two overclaimed readiness signals: Railway requires native
commit evidence matching a pinned commit, and Kubernetes cannot count old ready pods
as successful realization of a surge rollout. Upstash HTTP-date retry delays now
share the numeric header's five-minute cap, including dates beyond timer range.
Each finding has a regression that failed before its repair. The shared-policy
[delivery record](0023-shared-budget-policy-ci.md) also records CI review repairs.

## Executable scenario ledger

Paths below identify regression suites, including negative controls and failure injection.
The design's acceptance matrix is the behavioral contract; passing a suite does not
substitute for a live provider's evidence.

| Reviewed failure or attack | Executable evidence |
| --- | --- |
| Manifest round-trip silently removes budget policy | `packages/bindles/test/manifest/manifest.test.ts` |
| Credit routing never reaches deployment selection; raw monthly/hourly comparison; missing or stale prices; unsupported objective | `packages/cloud/test/hosting-budget.test.ts` |
| Expected cost fits but bounded usage, fixed charges or transition cost exceed cap | `packages/cloud/test/hosting-budget.test.ts` |
| Destination credits erase source egress; credits pay ineligible cost classes | `packages/cloud/test/hosting-budget.test.ts` |
| Shared resources consume the same allowance twice; account cap bypass | `packages/cloud/test/hosting-budget.test.ts`, `packages/broker/test/hosting-budget.test.ts` |
| Concurrent paid/credit/capacity reservations; duplicate IDs; running work expires into free headroom | `packages/dispatcher/test/budget-safety.test.ts` |
| Two independent gateway workers admit 60 each against 100; fractional time credits lose precision | `packages/hobo/test/hosting-budget-authority.test.ts` |
| Crash after financial admission but before gateway facts; replay changes payload | `packages/cloud/test/hosting-budget-gateway.test.ts`, `packages/hobo/test/hosting-budget-authority.test.ts` |
| Gateway and execution double-reserve; another transition reuses the hold | `packages/hobo/test/hosting-budget-authority.test.ts`, `packages/broker/test/hosting-budget.test.ts` |
| Cap revision or period reset erases live paid or zero-cash obligations; provider watermark removed | `packages/broker/test/hosting-budget.test.ts`, `packages/broker/test/budget-signals.test.ts` |
| Protected recovery funds or unresolved external liabilities spent by ordinary admission | `packages/broker/test/hosting-budget.test.ts`, `packages/hobo/test/hosting-budget-authority.test.ts` |
| Lost provider acknowledgement; crash/reopen; duplicate worker; stale fence; timeout | `packages/cloud/test/hosting-transition.test.ts` |
| Authorization finishes after expiry or another worker advances the operation | `packages/cloud/test/hosting-transition.test.ts`, `packages/hobo/test/hosting-budget-authority.test.ts` |
| Cancellation between steps or during verification strands recovery | `packages/cloud/test/hosting-transition.test.ts` |
| Foreign, stale or wrong-operation observations advance execution | `packages/cloud/test/hosting-transition.test.ts`, `packages/stations/test/traffic-routing-hardening.test.ts` |
| Health failure or exhausted budget is trapped behind optimization cooldown | `packages/stations/test/traffic-routing-hardening.test.ts` |
| Concurrent signals or restart overlap cutovers; checkpoint version fails to advance | `packages/stations/test/traffic-routing-hardening.test.ts` |
| Final ramp drops availability constraints; missing health, readiness, TTL or financial approval | `packages/stations/test/traffic-routing-hardening.test.ts` |
| Health probes repeat provider mutations; restart accepts routing status without fresh service health | `packages/stations/test/traffic-routing-hardening.test.ts` |
| Compensation returns none, throws, restores an unavailable source or restores the wrong artifact | `packages/stations/test/traffic-routing-hardening.test.ts`, `packages/cloud/test/hosting-transition.test.ts` |
| Single-writer ownership or reverse synchronization is missing after target writes | `packages/cloud/test/hosting-transition.test.ts`, `packages/stations/test/traffic-routing-hardening.test.ts` |
| Traffic moved but old capacity remains billable; actual cost exceeds estimate; settlement is understated | `packages/cloud/test/hosting-transition.test.ts`, `packages/hobo/test/hosting-budget-authority.test.ts` |
| Latency requirement ignored; metrics graph unused; Pareto dominance mistaken for invalidity; normalization changes when unrelated candidate appears | `src/draft/epic-proofs/finops-budget-routing-control-plane/tests/adversarial-routing.test.ts` and its `features/adversarial-routing.feature` |
| Generated records, CUE constraints, consumer contracts or ESM imports drift | Package schema/contract tests and `packages/schema-tools/test/package-template.test.ts` |
