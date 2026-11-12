---
type: Implementation Plan
title: "CI capacity providers and engines as catalog extensions: one-shot delivery plan"
description: "Complete design and swarm handoff for making every HoBo CI capacity provider (Jog, Blacksmith, Depot, Boat, Lizard, WarpBuild, GitHub-hosted, the box, ARC, Vercel Sandbox and the modelled sandboxes) and every CI engine a catalog extension with no closed enum in core: provider self-models, fact requirements evaluated by policy, can-deploy verdicts, allowances and credits in the pricing engine, per-provider balance sources, accounting for externally assigned work, fleet-wide balancing, failure table and measurable outcomes."
tags: [hobo, ci, fleet, providers, extensibility, finops, policy, implementation, sdlc]
---

# CI capacity providers and engines as catalog extensions: one-shot delivery plan

**Status:** proposed for dispatch. Nothing in this plan is built. Provider facts in Appendix A were read from the vendors' own pages on 2026-11-12; every one carries its source and every gap is marked "not documented".
**Design authority:** a new ADR written in layer C0 (this plan calls it **ADR-0181**; take the next free number at dispatch, because two in-flight stacks both claim 0180). It applies [ADR-0090](../design/adr/01-architecture-core.md) ("extensibility is catalog extension, not enum editing") and [ADR-0156](../design/adr/07-portability-extensibility.md) (`hobo.plugin/v1`) to CI, and amends ADR-0178 (provider manifest) and ADR-0180 (fleet verdict).
**Base:** `main` after the routing stack ([#1962](https://github.com/Hobo-Labs/HoBo/pull/1962) to [#1968](https://github.com/Hobo-Labs/HoBo/pull/1968)) and the HoBo.CD stack ([#1945](https://github.com/Hobo-Labs/HoBo/pull/1945) to [#1951](https://github.com/Hobo-Labs/HoBo/pull/1951)) have merged. Layers L01 to L05 and L07 to L14 touch none of their files and may start on `main` today.

**What "one shot" means here.** The whole build is one set of stacked layers with nothing left for a later project. Live proof needs real provider accounts and clock time, so section 6.16 is an operating checklist with evidence gates, run after the stack merges. It adds no code. A provider whose account the owner has not connected ends the plan `blocked-on-credentials`, never `not-implemented`.

## 1. How to use this document

- **Coordinator (parent session).** Run the repo's `sdlc` protocol. Each layer in section 9 becomes one issue: its body there, plus the design sections it cites, copied in verbatim. Own every item marked *coordinator* and every shared file in section 9.2. Record the lanes in `docs/plans/ci-providers-as-catalog-extensions/sdlc-state.md` before dispatch.
- **Implementers.** One layer each. Red test, minimal change, commit. `pnpm agent:check -- --staged` before every commit. Conventional commits with a DCO sign-off (`git commit -s`), several per layer. Touch only the files your layer owns; anything else is a `cascadeDelta` in `.sdlc/report.json`.
- **Reviewers.** Check the layer against its acceptance list and against every row of sections 7 and 8 that names the layer.
- **Swarm.** Appendix D gives the wave schedule and the per-layer pipeline (implement, review, verify) for a parallel workflow. No two agents may work in one package at the same time.

## 2. Problem

| Finding (2026-11-12) | Evidence | Cause |
| --- | --- | --- |
| The docs say `jog`, `boat` and `lizard` are accepted policy provider kinds. The parser rejects all three | `docs/design/ci-fleet-balancing.md` L213, `site/src/pages/ci/providers.md` L208; `packages/ci/src/policy.ts` L31-43, `packages/ci/data-models/ci.cue` L283, `packages/ci-gh-actions/src/project-providers.ts` L74 | Provider names are closed lists kept in several files that already disagree |
| Adding one provider means editing core in many places and breaks every older relay | About 312 provider or engine literals in 57 source files, 588 more in 115 test files, 55 in 42 fixtures (Appendix C). `packages/ci/RUNNER-QUEUE.md` L342: "an unknown kind fails policy parsing" | The CI packages do not follow ADR-0090 |
| Jog, Blacksmith and Depot are recorded in `.hobo/ci.json` `integrations` with `enabled: false`, and nothing reads that block for dispatch | `.hobo/ci.json` L17-50; `packages/ci-gh-actions/src/project-config.ts` L539-557 | The record is written by `hobo ci connect` and consumed by nothing |
| No job can reach a rented label provider | `scripts/ci/route-runner.mts` L342-366: three members, the fleet, a local box and GitHub-hosted | The route job has a fixed member list |
| A job routed by label is never accounted | `packages/ci-gh-actions/src/hosted-relay.ts` L1061-1069 returns `ignored` for a label the fleet does not serve; `isOverflowRunnerLabel` is unused | Paid minutes would bypass the budget; `ci-fleet-balancing.md` L187-192 names this as a precondition |
| Included minutes and credits never reach the pricing engine for a real account | `packages/provider-manifest/src/billing.ts` L46-50: included usage is not lowered to an allowance; no code reads any provider's usage API | A grant needs a tenant and dated evidence, and nothing supplies them |
| Provider restrictions are fields of one hard-coded TypeScript type that names repositories and forks | `packages/ci/src/fleet/models.ts` `eligibility`; `packages/ci/src/fleet/balance.ts` `ineligible()` | The provider's own rules are not policy, and the model knows the engine is GitHub |
| 42 workflow runs were queued at once | GitHub Actions run list, 2026-11-12 22:56 UTC | Not diagnosed in this plan. What is known: the fleet's only overflow today is GitHub-hosted, and five workflows have no route job, so their jobs wait on the fleet's own label |

**The shared pattern:** the fleet's providers are code and closed lists, so every claim of support is a promise the parser, the router and the accounts each keep separately, or do not keep.

## 3. Goals and rules

**Goals**

1. A provider or an engine is added by publishing a package or a manifest. No file under `packages/ci*`, `packages/core` or `packages/hobo/src` changes.
2. A provider is modelled the way it models itself (its machines, plans, included usage, credits, restrictions, sign-in and usage API) and lowered to common types every decision is made on.
3. A provider's restrictions are requirements in its model, evaluated by policy. `hobo can-deploy` answers from policy configuration and says no with the provider's own statement.
4. No work is ever sent to a provider whose requirements the work does not meet.
5. Included usage is spent before prepaid credit, and credit before cash. Cash never exceeds the authored ceiling.
6. The owner's existing Jog, Blacksmith and Depot accounts connect without a new plan being opened, and Boat, Lizard and WarpBuild connect the same way.
7. Every configured member of the fleet takes part in one balancing decision, and paid usage is visible per provider.
8. Every provider and engine the repo names today keeps working. Nothing is removed.

**Owner rules (binding on every layer)**

- **R1. No provider or engine enum.** No closed set, union, CUE disjunction, zod discriminated union or `===` branch on a provider or engine name in core, CI or CLI source. Names live in catalog data and in the package that owns the provider.
- **R2. Catalog extension.** A provider or engine reaches the system through `hobo.plugin/v1` or a provider manifest. An unknown kind never fails a whole policy; it disables that entry with a reason.
- **R3. Self-models.** Provider facts are data with a source URL and the day they were read. A fact past its `validUntil` takes the provider out of rotation.
- **R4. Policy, not code.** A restriction is a requirement over named facts. Core never names a restriction.
- **R5. Engine-blind policy.** The CI policy and core know fact names and values. They do not know Git, GitHub, repositories, forks or labels. An engine plugin maps its world onto facts and bindings.
- **R6. Typed extensions.** Provider-specific and engine-specific policy fields are contributed types: a schema the plugin ships, parsed into a typed value (parse, don't validate). Core carries them as an open envelope.
- **R7. Keep every capability.** GitHub Actions, Azure DevOps, Dagger, Cloudflare, the box, a local box, ARC, Vercel Sandbox, GitHub-hosted, Blacksmith, Depot, WarpBuild, Jog, Boat, Lizard and the modelled sandboxes all remain, each as an extension.
- **R8. Backwards compatible.** Every `.hobo/ci.json` and every persisted policy that parses today parses to the same decision after this plan.
- **R9. Secretless first.** Running a job needs no stored secret. A balance read may need a read-only token; it is a reference into the secret store, never a value in a file, a command line or a log.
- **R10. Fail closed.** A requirement over a fact nobody supplied is unmet. A balance that cannot be read is treated as stale, never as full.
- **R11. Repo architecture rules.** PACT at every service boundary, protobuf plus CUE for every record with generated runtime types, `data-models/` per package, parse-don't-validate, and the boundary lint (an adapter imports `@hobo/core` and contract packages only).
- **R12. Honest status.** Docs and the scorecard are generated from the catalog and from recorded evidence. No hand-written claim of support.

**Not in scope, and why**

- **Routing one run's jobs to several providers.** The route job picks one label per run, and plan 0025 keeps that. Different runs already spread across members, which is what relieves the queue. Section 12 records the alternative.
- **The HoBo.CD delivery fleet.** That fleet is the set of hosts an application is delivered to. This plan is the fleet of machines CI jobs run on. They share no record.
- **Host drivers for the modelled sandbox providers** (Agent37, Modal, Daytona, E2B, Northflank, Freestyle, Blaxel, Runloop, Cloudflare Sandbox). They keep exactly today's status: modelled, priced, listed and never matched. This plan moves them into the catalog as `held` entries so a driver can be contributed later as a plugin with no core change.

## 4. Terms

| Term | Meaning |
| --- | --- |
| **Capacity provider** | Anything that supplies machines for CI work: a rented runner service, the box, a cluster, a sandbox service |
| **Engine** | The system that defines and schedules pipelines: GitHub Actions, Azure DevOps, Dagger, Cloudflare |
| **Offering** | One machine class of one provider: size, isolation, price, how work is bound to it |
| **Binding** | How a job reaches an offering. An engine contributes the kinds. GitHub Actions contributes `label` (the job asks for the provider's label before it is queued) and `inject` (the relay starts a runner for a job already queued) |
| **Fact** | A named, typed value about a piece of work, an account or a scope, supplied by an engine or recorded at connection. `work.source.visibility = public` |
| **Requirement** | A provider's rule over facts, with its statement and source |
| **Descriptor** | A provider's self-model lowered to the common record: offerings, requirements, billing, sign-in flows, balance sources, exhaustion behaviour, evidence |
| **Connection** | One of the owner's accounts at a provider, as HoBo knows it: plan, account facts, secret references |
| **Observation** | A dated reading of a connection's balances with a provenance: `native`, `derived` or `attested` |
| **External assignment** | Work a provider's own runner took because the job asked for its label. HoBo did not launch it ([fleet enrollment design](../design/fleet-enrollment-design.md), section 2.2) |
| **Catalog** | The set of registered providers and engines, with a digest |
| **Lock file** | `.hobo/ci.lock.json`: the catalog data a workflow needs, compiled from policy and committed, so the route job needs no install |
| **Held** | Registered and listed, never matched (ADR-0178). The state of a provider with no driver, or one not yet approved |

## 5. Facts the design rests on

**In the repo**

1. `hobo.plugin/v1` is open by construction: `point` only has to match `^hobo\.[a-z0-9][a-z0-9.-]*\/v[0-9]+$` (`packages/core/src/extension-registry.ts` L15). Only `hobo.cloud-provider/v1` has a host seam; any other point is reported `skipped` (`packages/hobo/src/plugin-loader.ts` L184-216).
2. `createExtensionRegistry<T>(point, entries, {duplicates, sealed})` exists in `packages/core/src/extension-registry.ts` L81 and nothing but its tests calls it.
3. Runner provider packages exist: `packages/providers/runner-github`, `runner-blacksmith`, `runner-depot`. Each has `src/`, `test/`, `contracts/` (PACT), `data-models/` (proto and CUE), a `catalog-entry.ts` that matches `RegistrableProvider`, and is registered in `packages/hobo/src/cli.ts` L148-154. Their records are hand-declared, which AGENTS.md forbids for new work.
4. `runner-blacksmith` and `runner-depot` import `@hobo/runner-github`. Those edges are banked exceptions in `packages/conformance/src/boundaries.ts` L427-429, a list that "should only ever shrink". A provider may not import `@hobo/pricing` or `@hobo/provider-manifest` (layer 3).
5. `@hobo/provider-manifest` (ADR-0178) declares auth flows, capabilities and billing as data. It has `IncludedUsage{billable, quantity, reset}`, the open `ExtensionAuthFlow{type: x-…, params}`, and no section for requirements, balances or credits. An unknown field is an error.
6. `@hobo/pricing` models both grants: `AllowanceGrant{…, exhaustion: bill-overage | block-usage, evidence}` and `CreditGrant{category: paid | promotional | support-adjustment, faceValue, …}`. A grant without valid evidence is `STALE_OBSERVATION` (`packages/pricing/src/state.ts` L200-233).
7. A typed requirement language exists: `{key, operator: equals | at-least | at-most | one-of | includes-all, value, necessity}` (`packages/manifest-capability/src/requirement.ts` L36-52), evaluated by `featureSatisfied` (`packages/capability-profiles/src/selection.ts` L195-222).
8. A policy pack is `{id, version, rules: PolicyRule{id, when(req), decide(req)}}` (`packages/contracts/src/policy-pack.ts`). The Gatekeeper already evaluates one in its `policy` gate and reports `{gate: "policy", code: "policy-denied", details: {policyIds, violations}}`. Its gate list is closed, so a new gate would be a core edit; a pack is not.
9. `hobo can-deploy` (`packages/hobo/src/can-deploy-command.ts`) calls `evaluateCanDeploy` and never the Gatekeeper. `hobo verify` calls the Gatekeeper with an injectable `policyPack`.
10. An Offer's balances are written by exactly one route, `POST /v2/accounts/self/observations` (`packages/ci-gh-actions/src/hosted-control.ts` L649-797), which has no client method and no caller outside tests.
11. `PipelineBackend.observeFinalUsage` (`packages/ci/src/execution.ts` L35) is the one usage-readback hook, and no source implements it.
12. The relay already verifies a GitHub Actions OIDC token against a pinned workflow (`hosted-relay.ts` L2117-2122, the bridge host claim).
13. The route job runs on a GitHub-hosted machine with a sparse checkout and installs nothing. It imports `packages/ci/src/fleet-overflow.ts` as source.
14. The toolchain for a hosted machine is installed only when `RUNNER_ENVIRONMENT` is `github-hosted` (`.github/actions/ci-runner-preflight/hosted-toolchain.sh` L11). A rented runner registers as self-hosted.
15. HoBo's own runners register in runner group 1, the organization's Default group (`packages/ci-gh-actions/src/onboarding.ts` L433).
16. `Hobo-Labs/HoBo` is public and owned by an organization.
17. Coverage floors are per package (`vitest.coverage.config.ts`): global 87/79/89/88; `runner-blacksmith` 88/79/98/88; `runner-depot` 93/87/94/93; `runner-github` 87/82/87/87.
18. The fleet enrollment work set the scorecard pattern: a generated file with a status vocabulary pinned by a test, where CI rejects `partial`, `fail` and `deferred` (`docs/design/fleet-enrollment-scorecard.md`).

**About the providers** (full dossiers in Appendix A)

| Provider | Restriction it states | Included usage | Balance it exposes |
| --- | --- | --- | --- |
| Jog | No public repositories; an organization's Default runner group must not allow public repositories | 5,000 base minutes a month while credits are loaded | Per-run seconds and cost; no balance |
| Blacksmith | The GitHub App installs on an organization | 3,000 base minutes a month per organization | Billable minutes by CLI; no remaining figure |
| Depot | Runners serve organization-owned repositories only; a public repository needs the GitHub runner group to allow it | 2,000 (Developer) or 20,000 (Startup) base minutes | Billable seconds and cost per billing window |
| Boat | Public repositories are off until turned on per account; six-hour maximum; start-rate limits | Plan dollars returned as machine time | Wallet balance and plan hours remaining |
| Lizard | Organizations only; Linux x64 only | $19 of usage on Pro | Plan usage by CLI |
| WarpBuild | Organizations only; a public repository needs the GitHub runner group to allow it | Not documented | None documented |
| GitHub-hosted | None for standard runners | Free on public repositories; a dollar allowance on private ones | Usage and budgets by REST, organization administrator |

Two providers place opposite requirements on one organization-wide setting: Jog needs the Default runner group to refuse public repositories; Depot, WarpBuild and HoBo's own runners need it to allow them when a public repository is served. The design treats that setting as one fact both rules read (section 6.3).

## 6. Design

### 6.1 Extension points and the catalog

Two extension points are added on `hobo.plugin/v1`. Both get a row in `docs/design/extension-points.md`.

| Extension point | Port (in `@hobo/core`) | Registered by | Gate before it is matched |
| --- | --- | --- | --- |
| `hobo.ci-capacity-provider/v1` | `packages/core/src/ports/ci-capacity-provider.ts` | A package's `hobo` key, or `hobo registry add <manifest>` for a data-only provider | The `ci-capacity-provider` conformance suite, then approval |
| `hobo.ci-engine/v1` | `packages/core/src/ports/ci-engine.ts` | A package's `hobo` key | The `ci-engine` conformance suite, then approval |

```ts
// packages/core/src/ports/ci-capacity-provider.ts (signatures; records are generated from proto)
export const CI_CAPACITY_PROVIDER_EXTENSION_POINT = "hobo.ci-capacity-provider/v1";
export interface CiCapacityProvider {
  readonly kind: string;                              // policy `kind`, e.g. "jog"; ^[a-z][a-z0-9-]{0,62}$
  descriptor(): CapacityProviderDescriptor;           // the self-model, lowered
  readonly config?: ContributedSchema;                // provider-specific policy fields
  normalizeLegacy?(entry: JsonObject): JsonObject;    // old spellings into `config` (R8)
  observe?(input: ObserveInput): Promise<AccountObservation>;   // a balance source that needs code
  readonly traits?: CapacityTraits;                   // section 6.6
}
export interface ContributedSchema {
  readonly id: string;                                // e.g. "hobo.ci.kubernetes.config/v1"
  readonly jsonSchema: JsonObject;                    // draft 2020-12, additionalProperties: false
  parse(value: JsonValue): { ok: true; value: JsonObject } | { ok: false; errors: readonly string[] };
}
```

- The ports live in `@hobo/core` because an adapter may import nothing else (fact 4). The shared runner types now in `runner-github/src/types.ts` move there, `runner-github` re-exports them, and the two banked boundary exceptions are deleted.
- `packages/hobo/src/ci-catalog.ts` builds the catalog with `createExtensionRegistry` (`duplicates: "throw"`, sealed after composition). `registerPluginExtensions` gains one branch per new point.
- A **data-only provider** is a provider manifest and nothing else. `providerFromManifest` already yields a registrable provider; the new lowering `toCapacityProviderDescriptor` (section 6.2) yields its descriptor. A label-bound provider with a declarative balance source needs no code at all.
- The catalog has a **digest** (SHA-256 of the canonical JSON of every descriptor, sorted by kind). It appears in the lock file, in the relay's readiness answer and in every routing decision's log line.
- In-tree providers build their descriptor at codegen time: `packages/providers/<pkg>/manifest/<kind>.provider.yaml` is lowered by a repo script into `src/_generated/descriptor.ts`, which imports `@hobo/core` types only. `codegen:check` fails when the YAML and the generated file differ.

### 6.2 Common types

All records are protobuf first, with CUE constraints and generated TypeScript (`packages/core/data-models/ci_capacity.proto`, `ci_capacity.cue`, `buf.yaml`; generated into `packages/core/src/_generated/ci_capacity_pb.ts`).

```proto
message CapacityProviderDescriptor {
  string schema_version = 1;            // "hobo.ci-capacity-provider/v1"
  string kind = 2;
  string display_name = 3;
  string homepage = 4;
  repeated CapacityOffering offerings = 5;
  repeated FactRequirement requirements = 6;
  CapacityBilling billing = 7;
  repeated ConnectionFlow flows = 8;    // sign-in ceremonies, safest first
  repeated BalanceSource balance_sources = 9;
  ExhaustionBehaviour exhaustion = 10;
  repeated FactDescriptor account_facts = 11;   // facts recorded at connection
  string config_schema_id = 12;
  repeated SourceEvidence evidence = 13;
  string registration = 14;             // "matchable" | "held"
}
message CapacityOffering {
  string id = 1;                        // "x64-4vcpu-ubuntu-2404"
  string binding = 2;                   // engine-contributed: "label" | "inject" | x-…
  string selector = 3;                  // what the binding matches on, e.g. the label
  string role = 4;                      // "primary" | "overflow" | "last-resort"
  MachineClass machine = 5;             // vcpus, memory_gb, architecture, os
  string isolation = 6;                 // "dedicated-vm" | "sandboxed-container" | "shared"
  string billable = 7;                  // the provider's base billable unit
  string allowance_weight = 8;          // decimal; base units consumed per minute
  optional uint32 max_runtime_minutes = 9;
  optional uint32 concurrency = 10;
  repeated string features = 11;        // "container-daemon", "custom-image", …
  repeated FactRequirement requirements = 12;   // rules of this size only
}
message FactRequirement {
  string id = 1;
  string fact = 2;
  string operator = 3;                  // equals | one-of | at-least | at-most | includes-all
  google.protobuf.Value value = 4;
  repeated FactCondition applies_when = 5;      // all must hold for the rule to apply
  string statement = 6;                 // the provider's rule, in a sentence
  SourceEvidence source = 7;
  string refusal_code = 8;              // existing public code, e.g. "fleet.visibility"
}
message AccountObservation {
  string kind = 1; string connection_ref = 2;
  string observed_at = 3; string valid_until = 4;
  string provenance = 5;                // "native" | "derived" | "attested"
  repeated AllowanceBalance allowances = 6;     // billable, remaining, resets_at
  repeated CreditBalance credits = 7;           // category, remaining_micros, expires_at
  int64 spend_micros_this_period = 8;
  string currency = 9; string evidence_ref = 10; string source_id = 11;
  repeated FactValue account_facts = 12;        // facts a source can read, e.g. account.can-start
}
message ExhaustionBehaviour {
  string on_allowance = 1;              // "bill-overage" | "block-usage"
  string on_credit = 2;                 // "fail-at-start" | "queue" | "grace" | "bill-overage"
  optional uint32 grace_hours = 3;
  string reserve_micros = 4;            // credit below this takes the provider out of rotation
}
```

- Operator, provenance, role, isolation and exhaustion values are closed vocabularies of the language. They are not provider names, so R1 does not apply to them.
- `@hobo/provider-manifest` gains matching sections (`offerings`, `requirements`, `accountFacts`, `balance`, `exhaustion`, `credits` on a plan, `allowanceWeight` on an offering, `configSchema`) and the lowering `toCapacityProviderDescriptor(manifest)`. The manifest stays closed to unknown fields; the open slots remain the `x-` extension names.
- The existing `RUNNER_FINANCIAL_MODELS` array becomes the set of descriptors in the catalog. `runnerModelForOffer` reads the catalog.

### 6.3 Facts and requirements

**Facts are an open vocabulary.** A key matches `^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`. Core ships descriptors for the portable ones so that two engines map to the same key and a provider's rule works under both. An engine or a provider may contribute more under its own prefix.

| Portable fact | Values | GitHub Actions maps it from |
| --- | --- | --- |
| `work.source.visibility` | `public`, `private`, `internal` | The repository's visibility |
| `work.owner.kind` | `organization`, `individual` | The repository owner's type |
| `work.origin.trust` | `first-party`, `external-contribution` | Whether the head of a pull request is a fork |
| `work.trigger.class` | `change-proposal`, `trunk`, `merge-queue`, `manual`, `scheduled` | The event name |
| `work.needs.container-daemon` | boolean | The job class |
| `work.needs.isolation` | `dedicated-machine`, `shared` | Admission's isolation rule |
| `work.machine.vcpus`, `work.machine.memory-gb` | number | The job class, when stated |
| `work.machine.architecture`, `work.machine.os` | string | The pool |
| `work.duration.reserved-minutes` | number | The account's runtime and startup minutes |
| `scope.default-pool.public-sources` | `allowed`, `denied` | The organization's Default runner group setting |
| `account.<name>` | declared by the provider | Recorded at connection, or read by a balance source |

**Evaluation** is one function with no imports, `evaluateFactRequirements(requirements, facts)` in `packages/core/src/ports/fact-requirement.ts`. It returns every unmet requirement with the fact, the expected value, the actual value, the statement, the source and the refusal code.

| Case | Result |
| --- | --- |
| The fact is present and the operator holds | Met |
| The fact is present and the operator does not hold | Unmet, the requirement's `refusal_code` |
| The fact is absent | Unmet, `fleet.fact-unknown` (R10) |
| An `applies_when` condition does not hold | The requirement does not apply |
| The operator is unknown | Unmet, `fleet.requirement-invalid` |

The existing codes in `FLEET_REFUSAL_CODES` are a public contract and stay. Each requirement names the code it maps to. Six codes are added: `fleet.fact-unknown`, `fleet.requirement-invalid`, `fleet.scope-conflict` (a scope-wide setting another member needs set the other way), `fleet.kind-unknown`, `fleet.fact-mismatch` (a declared fact disagrees with the real one) and `fleet.catalog-skew`.

**The requirements the six rented providers state** (the form their manifests take):

| Provider | Requirement | Code |
| --- | --- | --- |
| Jog | `work.source.visibility` one-of `[private, internal]` | `fleet.visibility` |
| Jog | `scope.default-pool.public-sources` equals `denied`, when `work.owner.kind` equals `organization` | `fleet.scope-conflict` |
| Blacksmith | `work.owner.kind` equals `organization` | `fleet.organization-only` |
| Depot | `work.owner.kind` equals `organization` | `fleet.organization-only` |
| Depot | `scope.default-pool.public-sources` equals `allowed`, when `work.source.visibility` equals `public` | `fleet.visibility` |
| Boat | `account.public-sources` equals `enabled`, when `work.source.visibility` equals `public` | `fleet.visibility` |
| Boat | `account.external-contributions` equals `enabled`, when `work.origin.trust` equals `external-contribution` | `fleet.fork` |
| Boat | `work.duration.reserved-minutes` at-most `360` | `fleet.runtime` |
| Lizard | `work.owner.kind` equals `organization`; `work.machine.architecture` equals `x64`; `work.machine.os` equals `linux` | `fleet.organization-only`, `fleet.machine` |
| WarpBuild | `work.owner.kind` equals `organization`; the same public-source rule as Depot | `fleet.organization-only`, `fleet.visibility` |

The first-party hosts state theirs the same way. A local box requires `work.source.visibility` one-of `[private, internal]` and `work.origin.trust` equals `first-party`. A shared ARC scale set and a workstation offer `isolation: shared`, which a rule in the engine's own pack (`work.needs.isolation` equals `dedicated-machine` for a public source and for every change proposal) refuses. Every rule `ineligible()` applies today has a row in the migration table of L16; none is dropped.

### 6.4 Typed contributed configuration and the policy shape

A policy provider entry becomes an envelope. Core validates the envelope; the provider validates its `config`.

```json
{ "id": "depot", "kind": "depot", "connectionRef": "depot",
  "offering": "x64-4vcpu-ubuntu-2404", "enabled": true, "config": {} }
```

| Today | After | Owner of the type |
| --- | --- | --- |
| `kind` from a closed list | Any registered kind | The catalog |
| `runsOn` | `offering` (an offering id), or `config.selector` to override the label | The provider |
| `scaleSet`, `engine` (Kubernetes) | `config.scaleSet`, `config.engine` | The Kubernetes capacity provider |
| `location` (Vercel) | `config.location` | The Vercel Sandbox capacity provider |
| `engines: ["gh-actions"]` | Unchanged; also `engines: {"gh-actions": {…}}`, which `parseEnvironmentEngineList` already accepts | Each engine |
| `githubWebhookOrigin` | `engines["gh-actions"].webhookOrigin` | The GitHub Actions engine |
| `integrations[]` | `connections[]`: `{id, kind, enabled, flow, plan, facts, secretRefs, config}` | The provider's `flows` and `account_facts` |
| nothing | `facts`: the environment's declared facts for the development-time check | Engines and providers |

- **Backwards compatibility (R8).** `parseCiPolicy(json, catalog)` runs each entry through its provider's `normalizeLegacy` first, so every old spelling above still parses. `CiPolicyProvider` keeps its existing proto fields for wire compatibility and gains `string offering = 9` and `google.protobuf.Struct config = 10`. Persisted policies decode unchanged.
- **Unknown kind (R2).** An entry whose kind is not in the catalog is kept, forced to `enabled: false`, and reported as `fleet.kind-unknown`. It never throws. This removes the hazard in `RUNNER-QUEUE.md` L342.
- **Schemas.** CUE in core types `kind` as a pattern and `config` as an open struct. Each provider package ships CUE for its own config in its `data-models/`. The editor schema `packages/ci-gh-actions/schema/ci-project.schema.json` is generated by composing the installed providers' JSON Schemas (`if kind == X then config matches X's schema`), with an open object for a kind that is not installed.
- **Derived types.** A provider's `config.parse` returns its own typed value, and only the provider's code reads it.

### 6.5 Engines as plugins

```ts
// packages/core/src/ports/ci-engine.ts
export const CI_ENGINE_EXTENSION_POINT = "hobo.ci-engine/v1";
export interface CiEngine {
  readonly id: string;                                   // "gh-actions"
  readonly facts: readonly FactDescriptor[];             // the facts it supplies
  readonly bindings: readonly BindingDescriptor[];       // "label", "inject"
  readonly config: ContributedSchema;                    // its fields in an environment
  resolveFacts(event: JsonObject): Readonly<Record<string, JsonValue>>;
  policyPack?(): PolicyPack;                             // the engine's own rules
  verifyWorkloadIdentity?(token: string, expected: JsonObject): Promise<WorkloadIdentity>;
  createBackend(input: BackendInput): PipelineBackend;
}
```

- `BackendKind` (`packages/ci/src/execution.ts` L14) becomes a string checked against the engine registry. `CI_ENGINE_PACKAGE_IDS` and `isKnownCiEngineId` are replaced by the registry.
- `@hobo/ci-gh-actions` registers the GitHub Actions engine. Everything that names a repository, a fork, a label, a runner group or a webhook is behind it. `@hobo/ci-ado`, `@hobo/ci-dagger` and `@hobo/ci-cf` register theirs the same way; `hobo ci serve` reads the registry and stops special-casing any id.
- A relay composition must have at least one engine. Which one is required is the composition's choice, not core's.

### 6.6 Behaviour traits replace provider branches

Every runtime branch on a provider name in Appendix C (class BEHAVIOR) becomes a declared trait of the provider or the offering. ADR-0181 names the trait kinds, as ADR-0145 requires.

| Trait | Values | Replaces |
| --- | --- | --- |
| `launch` | `engine-assigned`, `bridge`, `host:<driver id>` | `lease.provider === "vercel"` choosing the sandbox host; box and Kubernetes choosing the worker |
| `settlement` | `engine-event`, `native-usage` | Vercel settling through stopped-usage snapshots |
| `quote` | `per-minute`, `multidimensional:<quote id>` | Sandbox pricing in `routing.ts` L218-233 |
| `isolation` (on the offering) | section 6.2 | `isIsolatedFleetProvider`, `isIsolatedCiOffer` |
| `abortable` | boolean | `shouldAbortIsolatedFleetLease` |
| `keeps-selector-when-queued` | boolean | `queuedDemandLabels` keeping a GitHub or ARC label |
| `rate-reattest` | boolean | `store.reattestRate` allowed for Vercel only |
| `counts-live-machines` | boolean | `live-container-count.ts` |

`role` (primary, overflow, last-resort) replaces the hard-coded ranks in `routing.ts` L412-420.

### 6.7 Billing: offerings, allowances, credits and exhaustion

- **One base unit per provider.** A provider declares one base billable, and each offering an `allowance_weight`. Usage is metered in base units: a ten-minute job on a weight-2 offering is 20 units. The rate card prices the base unit, so an allowance in base units and a per-size price are the same arithmetic. No change to `@hobo/pricing` is needed, and `packages/ci/src/provider-allocation.ts` (two hard-coded regexes) is deleted.
- **Grants come from a connection.** A descriptor's plan says what the plan includes. The connection says which plan the owner is on and since when. An observation says what is left. From those three the relay builds an `AllowanceGrant` and a `CreditGrant` with the tenant and dated evidence the pricing engine requires (fact 6). The catalog itself never carries a grant.
- **Order of spending.** `maximize-credits`: included usage, then promotional credit, then paid credit, then cash. Cash is the only one counted against the account's budget ceiling; credit spend is reported separately per provider.
- **A plan already open is not a job's cost.** A connection is an existing subscription (`subscribed: true`), so a plan fee is never charged to a job and `fleet.agreement.new-denied` cannot fire for it.
- **Exhaustion is the provider's own behaviour.** Where a provider fails a job at start once credit runs out (Jog), the provider leaves rotation when its remaining credit falls below `reserve_micros` plus the cost of the work already admitted to it and not yet settled.

Golden cases every implementation must reproduce exactly (ten-minute job, 4 vCPU class, `maximize-credits`):

| Provider | Starting balance | Consumed | Cash added |
| --- | --- | --- | --- |
| Blacksmith | 3,000 base minutes | 20 base minutes (weight 2) | 0 micros |
| Blacksmith | 10 base minutes | 10 base minutes, then 10 at $0.004 | 40,000 micros |
| Depot (Developer) | 2,000 base minutes | 20 base minutes | 0 micros |
| Depot (Developer) | 0 base minutes | none | 120,000 micros (20 at $0.006) |
| Jog | 5,000 base minutes, $50 credit | 20 base minutes | 0 micros, credit unchanged |
| Jog | 0 base minutes, $50 credit | $0.024 of credit | 0 micros |
| Jog | 0 base minutes, credit below reserve | not routed | 0 micros |
| Boat | 555 plan hours | 0.1667 hour | 0 micros |
| Lizard (Pro) | $19 of usage | $0.0054 | 0 micros |
| GitHub-hosted, public source | none | none | 0 micros |

### 6.8 Balance sources and the observation channel

A provider declares one or more balance sources, best first. Core ships four interpreters, so most providers need no code. A provider may also implement `observe` for anything else.

| Source kind | What it does | Provenance |
| --- | --- | --- |
| `http-json` | One HTTPS request (method, URL template, headers, body), then a field mapping from the JSON answer to balances | `native` when the answer states a remaining figure, else `derived` |
| `cli-json` | Runs a declared command with a fixed argument list and maps its JSON output | As above |
| `engine-derived` | The grant less the base units of the work the engine reported for this connection in the period | `derived` |
| `attested` | Figures the owner entered from the provider's dashboard, with a validity the provider's manifest caps | `attested` |

**Per provider (decided):**

| Provider | Default source | Optional source, when the owner stores a token | Why |
| --- | --- | --- | --- |
| Boat | `http-json` `GET https://boat.dev/api/v1/limits` | none needed | The key can be read-only (`account.read`) and the answer has the wallet and the hours remaining |
| Jog | `http-json` `GET https://usejog.com/api/orgs/{org}/advice/runs` plus `attested` credit | none needed | The token reads advice and nothing else. Jog exposes no balance, so the credit figure is entered and decremented by run cost |
| Depot | `engine-derived` | `http-json` `POST https://api.depot.dev/depot.core.v1.GithubActionsService/GetGithubActionsUsageProjection` | The documented organization token "can create, update, and delete projects and run builds". It is not read-only, so it is opt-in |
| Blacksmith | `engine-derived` | `cli-json` `blacksmith usage --format json` | The organization token is organization-wide and can shut machines down, so it is opt-in. No HTTP API is documented |
| Lizard | `engine-derived` | `cli-json` `lizard billing status --json` | The key's scope is not documented, so it is opt-in |
| WarpBuild | `engine-derived` plus `attested` | none | No usage API is documented |
| GitHub-hosted | `attested` zero price on a public source; `engine-derived` on a private one | `http-json` `GET /organizations/{org}/settings/billing/usage` | The endpoint needs an organization administrator |

**The channel.** Observation is a job, not a relay feature.

1. `.github/workflows/fleet-observe.yml` runs hourly and on dispatch, on `ubuntu-24.04`. It runs `hobo ci observe --all --json`.
2. The job signs in to the secret store with its OIDC token as a new read-only identity, `hobo-ci-observer`, and reads only the references the connections name (R9).
3. It posts each observation to `POST /v2/accounts/self/observations`. The relay accepts the job's OIDC token through the engine's `verifyWorkloadIdentity` (repository, `refs/heads/main`, and this workflow's path), the mechanism fact 12 already uses.
4. The relay stamps `valid_until` as the lesser of the provider's declared validity and 90 minutes for a scheduled source.

Third-party plugin code and provider CLIs therefore run in a job with a read-only identity, never inside the hosted relay. The relay reads descriptors, which are data.

**Reconciliation.** When a `native` or token-backed reading and the relay's own derived figure disagree by more than 2 percent or five base minutes, whichever is larger, the relay takes the more conservative figure, logs `hobo_ci_balance_drift` with both, and the CI health monitor raises it.

### 6.9 Accounting for externally assigned work

- The relay core (`HostedRelay`) stops ignoring a job whose binding selector belongs to an enabled offering. It asks the catalog which offering a selector belongs to; it never parses a label itself.
- On the engine's `in_progress` event it writes a lease in the external-assignment class against that offer; on `completed` it settles `completed − started`, in base units, through the pricing engine. `usageProvenance` is `engine-event`.
- The lease counts toward the offer's concurrency and the account's exposure from the moment the job is queued, as an intent, so a burst cannot overrun the budget between events.
- It is written through the existing `CiStore` port, so the SQLite box store, the Postgres store and the hosted cache all carry it. The store contract test (`ci-store-contract`) gains the cases.
- **After a cache loss** on the stateless hosted relay (ADR-0179), balances are re-seeded from the last observation and the period's externally assigned work is rebuilt from the engine's own job list, bounded to the current billing period.

### 6.10 Admission, balancing and routing

**One evaluator, three callers.** Requirements are evaluated by the same function in the relay's admission (`route`), in the fleet balancer (`balanceFleet`, where it replaces the provider-fact half of `ineligible()`), and in the route job.

**The lock file.** `hobo ci lock` compiles `.hobo/ci.lock.json` from the policy and the catalog: for each enabled offering its member id, binding, selector, role, authored order and requirements, plus the catalog digest and the environment's declared facts. A CI step fails when the committed file is not current. The route job reads it from its sparse checkout and evaluates requirements with `fact-requirement.ts`, which it imports as source the way it imports `fleet-overflow.ts` today.

**The route job's decision.**

| Step | Rule |
| --- | --- |
| Members | The fleet, a local box, every label-bound offering in the lock file, and the last-resort member |
| Eligibility | Requirements against the run's real facts (from the event), not the declared ones. A declared fact that disagrees with the real one is logged as `fleet.fact-mismatch` |
| Liveness | The existing queue evidence, per selector. A member is sent work only after a runner was seen taking a job for its selector |
| Relay | The fleet verdict can block a selector, with a new reason `budget` for a provider the relay will not admit. A ranked order, when the relay serves one, replaces the authored order |
| Order | Primary, then overflow in ranked or authored order, then last resort |
| Silence | No relay answer changes nothing (plan 0025, R3) |

**Probes.** `fleet-probe.yml` gains one probe job per label-bound selector in the lock file, each in its own concurrency group. A probe on a rented provider runs only when no pickup was seen for that selector in the last 15 minutes. A selector whose provider is refused for this source is never probed.

**The relay's ranking.** `GET /v1/fleet/routes/{owner}/{repo}` returns, per job class, the selectors `balanceFleet` admitted in order, with an expiry, kept and served like a verdict (ADR-0180 amendment). The `HOBO_CI_FLEET_ROUTES` variable publisher is retired.

**The toolchain on a rented machine.** `hosted-toolchain.sh` and the three other actions that test `RUNNER_ENVIRONMENT` test for the fleet image's own marker instead, so a rented runner gets the pinned toolchain exactly as a GitHub-hosted one does.

### 6.11 can-deploy

`ciFleetPolicyPack(input)` in `@hobo/ci` turns the catalog, a policy and a set of facts into a policy pack: one rule per requirement of each provider in the policy, plus each engine's own pack. `hobo can-deploy` and `hobo verify` evaluate it through the Gatekeeper's existing `policy` gate.

| Provider entry | Requirements against the declared facts | Row | Command result |
| --- | --- | --- | --- |
| Enabled | All met | `admitted` | Unchanged |
| Enabled | One unmet | `refused`, with the statement, the fact, expected, actual and source | `HOBO_CANNOT_DEPLOY`, exit 1 |
| Enabled | A fact undeclared | `refused`, `fleet.fact-unknown` | `HOBO_CANNOT_DEPLOY`, exit 1 |
| Disabled | One unmet | `refused`, reported | Unchanged |
| Kind not installed | none | `unknown`, `fleet.kind-unknown` | `HOBO_CANNOT_DEPLOY` if enabled |
| Two enabled entries need opposite values of one scope fact | The declared value contradicts one of them | That one is `refused` with `fleet.scope-conflict`, and the row names the entry it conflicts with | `HOBO_CANNOT_DEPLOY`, exit 1 |

The declared facts are the environment's `facts` block plus the facts the policy itself states (the pool's operating system and architecture). The command reads `.hobo/ci.json` and the installed catalog. It makes no network call and needs no credential. `hobo ci connect <kind>` prints the same rows at connection time.

### 6.12 Connecting an account

`hobo ci connect <kind>` is driven by the provider's descriptor. It names no provider.

1. Shows the provider's requirements against this project's declared facts (section 6.11).
2. Runs the first flow the descriptor lists. For all six rented providers that is the provider's own app installation in the browser. Nothing is stored.
3. Asks which plan the account is on, and for the account facts the descriptor declares (for example, whether public sources are turned on at Boat).
4. Reads a first observation: the declared source if one works without a token, otherwise figures the owner enters from the provider's dashboard.
5. Writes the connection and the policy entry to `.hobo/ci.json` as references only, and regenerates the lock file.
6. Dispatches the probe and reports whether the provider picked it up.

A token for an optional source is captured through the existing secret capture flow into the relay's store and referenced by name. The CLI never reads or prints one.

### 6.13 Security

| Threat | Control |
| --- | --- |
| Outside contributions running on paid machines | Every rented provider's manifest refuses `work.origin.trust = external-contribution` unless the provider documents support and the connection records it turned on. The budget ceiling applies regardless |
| A community plugin running code | Loading is by explicit specifier and passes the approval gate. A data-only manifest runs no code. Plugin code runs in the CLI and in the observe job, never in the hosted relay |
| A balance token with wide powers | Token-backed sources are opt-in where the provider's token is not read-only (Depot, Blacksmith, Lizard, GitHub billing). The default source needs no token |
| A token in a file or a log | References only. The existing leak test is extended to every provider and every new surface |
| A token that expires (Jog allows 90 days at most) | The connection records the expiry by reference metadata. The observe job warns from 14 days before, and the provider falls back to its token-free source when the token lapses |
| A forged observation | The relay accepts one only from the pinned workflow on the default branch of the connected source |
| A provider changing a price or a rule | Evidence expires. A descriptor past `validUntil` leaves rotation and fails the docs freshness gate |

### 6.14 Version skew

- The relay reports its catalog digest at `/readyz`. `hobo ci lock` and the policy apply path compare it with the local one and report a mismatch as `fleet.catalog-skew`.
- A relay that does not know a kind disables that entry (section 6.4). It keeps serving every other provider.
- The lock file carries a schema version. A route job that reads a newer one than it understands uses the fleet's own labels and GitHub-hosted, as today.

### 6.15 Observability

| Event or series | Carries |
| --- | --- |
| `hobo_ci_fleet_decision` | The run, the facts, each member's verdict and code, the member chosen, the catalog digest |
| `hobo_ci_external_assignment` | The offer, the selector, base units, micros by source (allowance, credit, cash) |
| `hobo_ci_balance_observed` | The connection, provenance, remaining allowance and credit, validity |
| `hobo_ci_balance_drift` | Both figures and the difference |
| `hobo_ci_provider_out_of_rotation` | The reason: stale evidence, stale observation, below reserve, breaker open |
| CloudEvents `ci.ProviderAdmitted`, `ci.ProviderRefused`, `ci.BalanceObserved`, `ci.BalanceDrifted`, `ci.CreditReserveReached` | The same facts, for reacting |

`hobo ci fleet` prints every member with its verdict for this project, its balances, their provenance and age, and the last ten decisions. `hobo ci fleet explain <run>` prints one decision.

### 6.16 Rollout, rollback and the operating checklist

| Phase | What changes | Gate to leave it |
| --- | --- | --- |
| 0. Dark | All code merged. `.hobo/ci.json` untouched | Outcomes M1 to M18 hold; the decision-equivalence test (M11) is green |
| 1. Deploy | The hosted relay and the box daemon run the new build | Both report the same catalog digest; one full CI run is unchanged |
| 2. Shadow | `.hobo/ci.json` migrated with `routing.mode: "shadow"`. The route job logs what it would choose and still chooses as before | 48 hours; no decision would have sent work to a refused provider |
| 3. Enforce, one provider at a time | Blacksmith, then Depot, then each further connected provider | For each: probe picked up within 120 seconds; one pinned acceptance run green; its lease and cost recorded |
| 4. Operating window | Seven days of normal traffic | Outcomes M19 to M24 hold |

**Rollback.** A provider is taken out by setting its entry to `enabled: false` (a one-line change) or, at once, by the existing `HOBO_CI_ROUTE=fleet` pin. The code path for a policy with no rented provider is the one phase 0 proved unchanged.

## 7. Failure scenarios and resiliency

| # | Scenario | What happens | Layer |
| --- | --- | --- | --- |
| F1 | A provider's app is not installed, or its label is wrong | The probe is never picked up, so no run is routed there. `hobo ci fleet` shows "no pickup seen" | C1 |
| F2 | A provider is down after runs were routed | Jobs already queued on its label wait (the engine fixes the label). The member's breaker opens after two pickups slower than the limit, and no new run goes there for an hour | C1, L22 |
| F3 | A provider's usage API is down | The last observation stands until `valid_until`, then the token-free source is used. If none is valid the provider leaves rotation | L24 |
| F4 | A balance token expires | Warned 14 days ahead. On expiry the source fails, F3 applies, and the scorecard row turns `blocked-on-credentials` | L25 |
| F5 | Credit runs out at a provider that fails jobs at start | The reserve takes the provider out before zero. A job that still fails for that reason is classified as infrastructure and its run is re-routed once | L22, C1 |
| F6 | An auto top-up changes a credit balance the provider does not expose | The attested figure's validity is capped at seven days and a larger native reading always wins | L10 |
| F7 | The hosted relay loses its cache | Balances re-seed from the last observation and the period's work is rebuilt from the engine's job list | L24 |
| F8 | The relay does not know a kind | That entry is disabled with `fleet.kind-unknown`. Everything else is served | L06 |
| F9 | Two members need opposite values of one scope fact | can-deploy refuses the one the declared fact contradicts and names the other. The route job refuses whichever the real fact contradicts | L22, L25 |
| F10 | A declared fact is wrong (a source turned public) | The route job and the relay use the real fact and log `fleet.fact-mismatch`. can-deploy catches it at the next change | C1, L24 |
| F11 | An outside contribution | Rented members refuse it. It runs on the fleet or the last-resort member, as today | L16 |
| F12 | A burst of runs chooses in the same second | The existing turn-taking stands. Queued intents count against the offer at once, so the budget cannot be overrun between events | L22, L24 |
| F13 | The lock file is stale | A CI step fails the change that left it stale. A route job that reads a stale one still evaluates real facts | C1 |
| F14 | A descriptor's evidence expires | The provider leaves rotation, the docs freshness gate fails and names it | L16, C2 |
| F15 | A plugin throws, or returns a malformed descriptor | Registration reports it and skips it. The conformance suite would have refused it. No other provider is affected | L05 |
| F16 | The observe job cannot sign in | No observation is posted. F3 applies. The health monitor raises a missed observation after two runs | C1 |
| F17 | Derived and native figures drift apart | The conservative figure is used and `hobo_ci_balance_drift` is raised | L24 |
| F18 | A rented machine lacks the toolchain | The preflight installs it. A failure there fails the job in its first step with the missing tool named | C1 |

## 8. Measurable outcomes

Every row is checked by a command, a test or a recorded figure. The generated scorecard (`docs/design/ci-provider-catalog-scorecard.md`, from `scripts/generate-ci-provider-scorecard.mts`) holds one row per outcome and per provider. Its test allows two statuses at completion: `pass` and `blocked-on-credentials`.

**Code and structure**

| # | Outcome | Measure | Target |
| --- | --- | --- | --- |
| M1 | No provider or engine name in core, CI or CLI source | `pnpm run ci:provider-literals` over the files of Appendix C | 0 hits outside the exemption list; the list has at most 12 entries, each with a reason. Baseline: about 312 hits in 57 files |
| M2 | A provider is added with no core change | `test/ci-extensibility.e2e.test.ts` installs `examples/ci-provider-acme` (a package that imports `@hobo/core` and `@hobo/sdk` only) and a second, data-only manifest | Both are registered, parsed in a policy, refused and admitted by can-deploy, ranked by the balancer and present in the lock file; `git diff --stat` over `packages/ci*`, `packages/core`, `packages/hobo/src` is empty |
| M3 | Every provider and engine passes its conformance suite | `pnpm exec turbo run test --filter=@hobo/conformance` | 100 percent of registered providers (at least 26 descriptors) and all 5 engine ids of today's inventory (`gh-actions`, `vercel`, `dagger`, `cf`, `ado`) |
| M4 | Boundary exceptions shrink | The banked list in `packages/conformance/src/boundaries.ts` | Two fewer entries; none added |
| M5 | Records are generated | `pnpm run codegen:check` and `pnpm run generated:guard` | Green; no hand-declared record in a new or migrated package |
| M6 | Contracts exist at every boundary | `pnpm run test:contract` | Green; at least one pact per token-backed or HTTP balance source, and for each new relay route |

**Behaviour**

| # | Outcome | Measure | Target |
| --- | --- | --- | --- |
| M7 | can-deploy verdicts for this repository's facts (public, organization) | Golden file `packages/hobo/test/fixtures/ci-fleet-verdicts.json` | Jog refused (`fleet.visibility`); Blacksmith admitted; Depot and WarpBuild admitted when the default pool allows public sources, refused otherwise; Boat refused until public sources are on at the account; Lizard admitted; exit 1 when a refused provider is enabled |
| M8 | No work reaches a provider whose requirements it does not meet | A property test of 10,000 generated demands, fact sets and fleets against `route`, `balanceFleet` and the route job | 0 violations |
| M9 | Spending order and arithmetic | The ten golden cases of section 6.7 | Exact to the micro-dollar and the base unit |
| M10 | Cash never passes the ceiling | A property test of 10,000 admission sequences | 0 sequences in which admitted cash exceeds the ceiling |
| M11 | Decisions are unchanged for every existing policy | Every valid fixture (42 files), the repository's own `.hobo/ci.json` and a recorded set of 500 admission inputs, evaluated before and after | 100 percent equal decisions; every persisted policy binary decodes |
| M12 | An unknown kind does not break a policy | A unit test | The entry is disabled with `fleet.kind-unknown`; the other entries are admitted |
| M13 | A stale balance is never trusted | Unit tests on expiry | The provider leaves rotation within one dispatch pass of `valid_until` |
| M14 | The route job never fails a run | The existing invariants, rerun with 12 members | Green; with the relay silent the choice equals the lock file's order |
| M15 | No secret reaches a file or a log | The leak test, extended | 0 of at least 60 synthetic tokens across every provider and every new command, file and log line |

**Quality gates**

| # | Outcome | Measure | Target |
| --- | --- | --- | --- |
| M16 | Tests are kept | Test counts recorded at C0 and at the end | No test file removed without a replacement; the count of test cases does not fall |
| M17 | Coverage | `pnpm run test:coverage` | Global floors hold (87/79/89/88). Each new package at least 90/80/90/90. No existing floor lowered |
| M18 | Mutation score of the two pure cores | Stryker on `fact-requirement.ts` and the balance arithmetic | At least 85 percent |
| M19 | The repository's gates | `architecture:guard:all`, `lint:boundaries`, `konsistent`, `test:schema`, `standards:check`, `licenses:check`, `lint:slop`, `lint:code`, `typecheck`, `build`, `docs:freshness`, `docs:okf`, `lint:docs`, `design:lint` | All green |
| M20 | Speed | A bench on `route` and on requirement evaluation | `route` p95 with 12 members within 10 percent of the baseline; one provider's requirements evaluated in under 50 microseconds; the route job at most 5 seconds slower |

**In production (operating window)**

| # | Outcome | Measure | Target |
| --- | --- | --- | --- |
| M21 | Each connected provider takes work | A probe pickup and one pinned acceptance run per provider, linked in the finding | Pickup within 120 seconds; the run green on that provider's machine; a lease with that provider's kind; cost settled |
| M22 | Accounting matches the provider | The relay's derived usage against the provider's own figure, daily | Within 2 percent or five base minutes a day |
| M23 | Decisions use fresh balances | Share of admissions to a rented provider made with an observation inside its validity | At least 99 percent |
| M24 | The queue | Wait from queued to started for pull-request jobs over seven days; runs with a job queued over ten minutes for want of capacity | p95 at most 120 seconds; 0 such runs. Baseline: 42 runs queued at once on 2026-11-12 |
| M25 | No refused provider was used | Jobs seen on a selector of a provider refused for this source | 0 |
| M26 | Spend | Cash, credit and allowance used, per provider | Cash at most the authored ceiling; a report per provider exists for the window |
| M27 | Honest documents | Provider pages and tables are generated from the catalog | `fleet-docs` freshness test green; the three false claims of section 2 are gone |

## 9. Delivery

### 9.1 Lanes and what runs in parallel

A lane is one stack. Layers in one wave share no package and run at the same time.

| Wave | Layers | Depends on |
| --- | --- | --- |
| 0 | C0 (coordinator) | none |
| 1 | L01 | C0 |
| 2 | L02, L03, L04, L05 | L01 |
| 3 | L06, L07, L08, L09, L10, L11, L12, L13, L14 | Wave 2 |
| 4 | L16, L17, L18, L19, L20, L21 | L06 |
| 5 | L22 | L16 |
| 6 | L23 | L21, L22 |
| 7 | L24 | L23 |
| 8 | L25 | L24 |
| 9 | C1, then C2, then C3 (coordinator) | L25 and the routing stack |

Layer numbers are identifiers; L15 is unused. Up to nine implementers run at once in wave 3. The longest chain is in two packages: `@hobo/ci` (L06, L16, L22) and `@hobo/ci-gh-actions` (L21, L23, L24).

### 9.2 Ownership

| Package or path | Layers, in order |
| --- | --- |
| `packages/core` | L01 |
| `packages/provider-manifest` | L02 |
| `packages/conformance` (new suites) | L03 |
| `packages/sdk`, `examples/ci-provider-acme` | L04 |
| `packages/hobo` | L05, then L25 |
| `packages/ci` | L06, then L16, then L22 |
| `packages/providers/runner-github` | L07 |
| `packages/providers/runner-blacksmith` | L08 |
| `packages/providers/runner-depot` | L09 |
| `packages/providers/runner-jog` (new) | L10 |
| `packages/providers/runner-boat` (new) | L11 |
| `packages/providers/runner-lizard` (new) | L12 |
| `packages/providers/runner-warpbuild` (new) | L13 |
| `packages/providers/runner-catalog-sandboxes` (new) | L14 |
| `packages/ci-vercel` | L17 |
| `packages/ci-ado` | L18 |
| `packages/ci-dagger` | L19 |
| `packages/ci-cf` | L20 |
| `packages/ci-gh-actions` | L21, then L23, then L24 |

**Coordinator-only (shared files).** Root `package.json` and the lockfile, `turbo.json`, `vitest.coverage.config.ts`, `.github/workflows/**`, `.github/actions/**`, `scripts/**`, `.hobo/**`, `packages/conformance/src/boundaries.ts`, `docs/design/**` indexes and `traceability.md`, `docs/design/extension-points.md`, `AGENTS.md`, `CLAUDE.md`, `site/**`, the `packages/hobo/src/cli.ts` registration block and `packages/hobo/package.json` dependencies for new packages. A layer that needs one reports a `cascadeDelta`.

### 9.3 Contract common to every layer

- **Guardrails.** R1 to R12. TypeScript only. Records from generated code. No exported string constant without a `// public-contract:` marker. No new banked boundary exception. No test skipped or deleted to go green.
- **Per-package gate.** `pnpm exec turbo run build typecheck lint test:unit test:schema test:contract:consumer --filter=<package>` green, and `pnpm run architecture:guard` green.
- **Definition of done.** The acceptance list holds; the package gate is green; the package's coverage floor holds; docs for the package move with the code; `.sdlc/report.json` lists gates, cascade deltas and any requirement change.
- **Verifiable output.** Each body names the artifact that proves it.

### 9.4 One-shot bodies

Each body is completed by the sections it cites, copied into the issue verbatim.

#### C0: decisions, baselines and guards (coordinator)

- **Scope.** ADR-0181 beside `docs/design/adr/`; two catalog rows in `docs/design/extension-points.md`; `docs/plans/ci-providers-as-catalog-extensions/sdlc-state.md`; `scripts/check-ci-provider-literals.mts` with the name list of Appendix C, in report-only mode, and its `ci:provider-literals` script; `scripts/generate-ci-provider-scorecard.mts`, its test and the first generated scorecard; recorded baselines (literal count, test counts per package, coverage per package, `route` bench, the 500 admission inputs for M11).
- **Acceptance.** The guard prints the baseline and exits 0. The scorecard test accepts `pass`, `blocked-on-credentials` and, until C3, `not-implemented`. Baselines are committed in the state file.
- **Verifiable output.** The ADR, the scorecard and the state file.

#### L01: ports, records and the evaluator (`@hobo/core`)

- **Why.** Every other layer codes against these types (sections 6.1 to 6.3, 6.5, 6.6).
- **Scope in.** `packages/core/data-models/ci_capacity.{proto,cue}` and fixtures; generated `_generated/ci_capacity_pb.ts`; `src/ports/ci-capacity-provider.ts`, `ci-engine.ts`, `fact-requirement.ts` (no imports), `fact-descriptors.ts` (the portable facts), `ci-catalog.ts` (catalog digest, kind lookup, selector lookup); exports; the public API snapshot. Move `RunnerProvider`, `BuildMachineProvider`, `ExecutionHostManifest`, `CreditBudget`, the category ports and SKUs from `runner-github/src/types.ts` as a `cascadeDelta` for L07.
- **Scope out.** Any provider or engine name. Any pricing change.
- **Steps.** Write the proto and CUE from section 6.2. Write failing tests for the evaluation table of section 6.3, including absent facts, `applies_when`, unknown operators and number coercion. Implement. Add the digest (canonical JSON, sorted by kind). Update the surface snapshot deliberately.
- **Acceptance.** Every row of the evaluation table has a test. `fact-requirement.ts` has zero import statements (asserted by a test that reads the file). Mutation score at least 85 percent on it. The digest is stable under reordering. `pnpm run codegen:check` green.
- **Verifiable output.** The generated types and `fact-requirement.test.ts`.

#### L02: the provider manifest carries a full self-model (`@hobo/provider-manifest`)

- **Why.** A provider is data (sections 6.1, 6.2, 6.7, 6.8).
- **Scope in.** Proto and CUE for `offerings`, `requirements`, `accountFacts`, `balance` (the four source kinds with their field mappings), `exhaustion`, plan `credits`, offering `allowanceWeight`, `configSchema`; `src/ci-capacity.ts` with `toCapacityProviderDescriptor`; `check` and `lower` in the CLI; fixtures valid and invalid; `examples/acme-runner.provider.yaml`; `docs/design/provider-manifest.md`.
- **Steps.** Extend the schema closed, as it is today. Lower included usage and credits into the descriptor's billing. Reject a requirement whose operator is unknown, a source whose mapping names no balance, a weight that is not a positive decimal, and a URL that is not HTTPS.
- **Acceptance.** The example lowers to a descriptor that passes L03's suite. At least ten invalid fixtures, each failing with its path. `providerFromManifest` registers a CI provider `held`, and the second run approves it. Coverage at least 90/80/90/90 on the new file.
- **Verifiable output.** `pricing-catalog.json` and `ci-capacity.json` written by `lower` for the example.

#### L03: conformance suites (`@hobo/conformance`)

- **Why.** A provider is matchable only after the gate (section 6.1).
- **Scope in.** `src/ci-capacity-provider/suite.ts`, `src/ci-engine/suite.ts`, their fixtures and tests, exports.
- **Checks for a provider.** The kind pattern; a descriptor that parses; unique offering ids; a base billable with a rate; every requirement names a fact with a descriptor or an `account.` fact the provider declares; every requirement has a statement, a source and a known refusal code; evidence is dated and unexpired; the config schema is closed and `parse` rejects an unknown field; `normalizeLegacy` is idempotent; a declared source maps to at least one balance; exhaustion is stated when a plan has credit; no credential-shaped string anywhere in the descriptor.
- **Checks for an engine.** The id pattern; every binding it declares is used by a fixture; `resolveFacts` returns only declared facts; its policy pack denies nothing for an empty fact set that it would allow for a full one.
- **Acceptance.** A deliberately broken fixture fails each check by name (at least 14 provider cases and 5 engine cases).
- **Verifiable output.** The two suites, used by L07 to L14 and L17 to L21.

#### L04: authoring helpers and the reference third-party provider (`@hobo/sdk`, `examples/ci-provider-acme`)

- **Scope in.** `defineCiCapacityProvider`, `defineCiEngine`, `defineFactRequirement` in `packages/sdk/src/`; `examples/ci-provider-acme` (a provider with a typed config, two requirements, an `http-json` source against a pact, and a `hobo` key) whose only dependencies are `@hobo/core` and `@hobo/sdk`; a short authoring guide in `packages/sdk/README.md`.
- **Acceptance.** `assertPluginExports` passes. The example passes L03's suite. A test fails if the example's `package.json` gains any other `@hobo/*` dependency.
- **Verifiable output.** The example package, used by M2.

#### L05: host seams for the two extension points (`@hobo/hobo`, first pass)

- **Scope in.** `src/plugin-loader.ts` (one branch per point, with shape checks like `parseRegistrableProvider`); `src/ci-catalog.ts` (compose the catalog from registered plugins and approved manifests, sealed); `hobo registry add` for a manifest with CI sections; tests.
- **Scope out.** `ci-command.ts`, `ci-connect.ts`, `ci-serve.ts`, `can-deploy-command.ts` (L25). The `cli.ts` registration block (coordinator).
- **Acceptance.** A plugin for each point registers and lists. A malformed one is reported with `HOBO_PLUGIN_PROVIDER_SHAPE` and skipped, and others still register (F15). A duplicate kind throws. The catalog digest equals L01's for the same set.
- **Verifiable output.** `plugin-loader.test.ts` cases for both points.

#### L06: open kinds and the configuration envelope (`@hobo/ci`, first pass)

- **Why.** R1, R2, R6, R8 (section 6.4).
- **Scope in.** `src/policy.ts`, `src/config.ts`, `data-models/ci.cue`, `policy.proto` and `ci.proto` (additive fields only), `src/fleet-v2/parse.ts`, `data-models/fleet_v2.cue`, `src/execution.ts` (`BackendKind`), `src/workspace-backend.ts`, `src/isolated-retirement.ts`, `src/scheduler.ts`; their tests, fixtures and the two pacts in `contracts/`.
- **Steps.** `parseCiPolicy(json, catalog)` and `parseConfiguration(json, catalog)` take the catalog. Kinds and backends are checked against it. Each entry is normalised by its provider, then its `config` parsed by its provider. The provider-to-backend pairing rules in `config.ts` L70-131 become each provider's declared `launch` trait and offering bindings. An unknown kind is disabled, not thrown (M12). Keep a test-only catalog fixture that reproduces today's eleven kinds exactly.
- **Acceptance.** Every existing test in `packages/ci/test` passes with the fixture catalog, unchanged in what it asserts. All valid fixtures parse to the same value as before (M11). `policy.ts`, `config.ts` and `ci.cue` contain no name from Appendix C. Old policy binaries decode.
- **Verifiable output.** The decision-equivalence test.

#### L07 to L09: the three existing runner packages

Common to all three: add `manifest/<kind>.provider.yaml` from the dossier in Appendix A; generate `src/_generated/descriptor.ts`; export a `CiCapacityProvider` and add the `hobo` key; move the package's records to generated types (`data-models/buf.yaml`); run L03's suite in `test/conformance.test.ts`; keep every existing export and test.

- **L07 `runner-github`.** Re-export the shared types now in core. Two offerings for the standard machine (a public source at zero price, a private source at the documented rate) expressed as one offering with a price condition on `work.source.visibility`, so the label has one model. Role `last-resort`. Refuses `ubuntu-latest` in its config schema (the rule now in `policy.ts` L325). Optional `http-json` billing source with a pact.
- **L08 `runner-blacksmith`.** Remove the dependency on `runner-github` (import core). Five x64 sizes with weights 1, 2, 4, 8, 16; base unit the x64 2 vCPU minute at $0.004; 3,000 included monthly; requirement organization-only. Sources: `engine-derived`, optional `cli-json`.
- **L09 `runner-depot`.** Remove the dependency on `runner-github`. Six sizes with weights 1 to 32; base unit $0.006; plans Developer and Startup with their included minutes; requirements of section 6.3. Sources: `engine-derived`, optional `http-json` with a pact for `GetGithubActionsUsageProjection`. Record in the dossier that the package's present `COST_FACTS` rate (0.0040) differs from the documented one, and re-read the pricing page before choosing.
- **Acceptance (each).** L03's suite green; existing tests green; the package's coverage floor holds; no import of another runner package; the golden cases of section 6.7 for that provider pass in a package test.
- **Cascade deltas.** Removal of the two banked exceptions; `cli.ts` registration.

#### L10 to L13: four new runner packages

Each follows the anatomy of `runner-blacksmith` (fact 3): `package.json` (private, ESM, `build`, `typecheck`, `lint`, `pretest`, `test`), `tsconfig.json`, `README.md`, `ADR.md`, `src/index.ts`, `src/manifest.ts`, `src/catalog-entry.ts`, `manifest/<kind>.provider.yaml`, `src/_generated/`, `test/`, `contracts/<name>-boundary.pact.json`, `data-models/` with `buf.yaml`, proto and CUE. Dependencies: `@hobo/core` only.

- **L10 `runner-jog`.** Ten offerings (five sizes, and Jog Max at twice the rate). Requirements of section 6.3. Flow: app installation. Exhaustion `fail-at-start` with a reserve. Sources: `http-json` on the Advice API (headers `Authorization: Bearer` and `Jog-Route-Version: 4`), plus `attested` credit capped at seven days. The alias `usejog` is declared in the manifest, replacing `ci-connect.ts` L66.
- **L11 `runner-boat`.** Four offerings with weights against the default machine. Plans $20, $100, $500 and $2,000 with their start limits and concurrency. Requirements of section 6.3; account facts `account.public-sources` and `account.external-contributions`. Flows: `boat ci connect`, then an API key by reference. Exhaustion `grace` of 24 hours. Source: `http-json` on `/api/v1/limits`, with `/api/v1/ci` for per-job reconciliation; a pact for both.
- **L12 `runner-lizard`.** Three offerings (Small, Medium, Large). Pro plans with dollars of included usage, modelled as a monthly promotional credit. Requirements of section 6.3. Sources: `engine-derived`, optional `cli-json`. A second, `held` offering set for the sandbox (the inject path) so a driver can be contributed later.
- **L13 `runner-warpbuild`.** Five x64 sizes at the documented rates. Requirements of section 6.3. Sources: `engine-derived` and `attested`. The kind is accepted by today's policy and has no package; this gives it one.
- **Acceptance (each).** L03's suite green; a leak test with at least five synthetic tokens; the golden cases for that provider; coverage at least 90/80/90/90; every figure in the YAML cites its page and day; each "not documented" item of the dossier is either resolved from the vendor's page or left out of the model, never guessed.
- **Cascade deltas.** `cli.ts` registration, `packages/hobo/package.json`, coverage floors.

#### L14: the modelled sandbox providers, held (`runner-catalog-sandboxes`)

- **Scope in.** One manifest per sandbox model now in `packages/ci/src/fleet/models.ts` (Agent37, Modal, Daytona VM and container, E2B Hobby and Pro, Northflank, Freestyle, Blaxel, Cloudflare Sandbox, Runloop, the Boat sandbox), copied figure for figure with their evidence, each `registration: held`.
- **Acceptance.** Every model's rate, machine, limits and evidence equal the present values (a test compares against a snapshot taken at C0). All pass L03's suite. None is matchable.
- **Verifiable output.** The snapshot test.

#### L16: the fleet reads the catalog (`@hobo/ci`, second pass)

- **Scope in.** `src/fleet/models.ts` (becomes catalog access and the `FleetBinding`, `FleetRole` types), `fleet/offers.ts`, `fleet/balance.ts`, `fleet/pricing.ts`, `fleet/route-table.ts`, `fleet/index.ts`, `src/provider-allocation.ts` (deleted, with its test replaced by weight tests), `scripts/fleet-docs.ts`, tests.
- **Steps.** `FleetDemand` carries `facts` instead of `repository`, `forkPullRequest`, `needsDocker`, `isolationRequired` and `machine`. `ineligible()` keeps the member-state checks (enabled, health, label reach, capacity, agreement) and calls `evaluateFactRequirements` for everything else. Build `AllowanceGrant` and `CreditGrant` from a connection and an observation (section 6.7); `RunnerCommercialState` gains remaining credit and the reserve. Write the migration table: one row per check in today's `ineligible()` with the requirement that replaces it.
- **Acceptance.** `fleet-balance.test.ts` and `fleet-offers.test.ts` pass with facts in place of the old fields and assert the same refusals by the same codes. The ten golden cases pass. M8 and M10 property tests pass. The generated provider pages are produced from the catalog.
- **Verifiable output.** The migration table in the layer's PR and the golden test.

#### L17 to L20: the first-party hosts and the other engines

- **L17 `ci-vercel`.** Registers the `vercel` engine id that today's engine inventory lists, so `engines: ["vercel"]` stays valid, and a capacity provider for the Sandbox: `launch: host:sandbox`, `settlement: native-usage`, `quote: multidimensional`, `rate-reattest: true`, config `{location}`, `normalizeLegacy` for the top-level `location`. `sandbox-composition.ts` stops comparing names.
- **L18 `ci-ado`, L19 `ci-dagger`, L20 `ci-cf`.** Each registers its engine and its capacity provider; its own id stays inside its package.
- **Acceptance (each).** L03's suites green; the package's existing tests green; no name from Appendix C outside the package's own manifest.

#### L21: the GitHub Actions engine (`@hobo/ci-gh-actions`, first pass)

- **Scope in.** `src/engine.ts` (the `CiEngine`: fact mapping, bindings `label` and `inject`, config schema with `webhookOrigin`, its policy pack, workload identity verification); `src/ci-engine-inventory.ts` and `engine-relay-routing.ts` (read the registry); `src/project-providers.ts`, `project-schema.ts`, `project-config.ts`, the two generated schemas; `src/runner-integrations.ts` (connections from descriptors; the secret scanning stays); `data-models/onboarding.cue`; `scripts/act-harness.ts`, `scripts/acceptance.ts`; tests.
- **Acceptance.** `project-providers.test.ts`, `project-config.test.ts`, `project-schema.test.ts` and `runner-integrations.test.ts` pass with a fixture catalog. The generated editor schema validates the repository's present `.hobo/ci.json` and the target one in Appendix B. `resolveFacts` maps the six event shapes in its fixtures to the portable facts of section 6.3.
- **Verifiable output.** The regenerated schemas and the fact-mapping fixtures.

#### L22: traits, external assignment and the policy pack (`@hobo/ci`, third pass)

- **Scope in.** `src/routing.ts`, `src/fleet-overflow.ts`, `src/store.ts`, `src/sqlite-store.ts`, `src/fleet/offers.ts` (the isolated-host test), a new `src/external-assignment.ts` (pure: intent, start, settle, rebuild), a new `src/fleet-policy-pack.ts`, tests.
- **Steps.** Replace every BEHAVIOR branch of Appendix C in these files with a trait read (section 6.6). `route` evaluates requirements before pricing and returns refusals. `FleetBackend` becomes a member id; the overflow order comes from role and authored order. Implement the reserve and the breaker. Implement `ciFleetPolicyPack`.
- **Acceptance.** `routing.test.ts`, `fleet-overflow.test.ts`, `scheduler.test.ts` and the SQLite store tests pass unchanged in what they assert. The store contract gains external-assignment cases and both stores pass. M9, M10, M12 and M13 hold. `pnpm run ci:provider-literals` reports 0 for `packages/ci`.
- **Verifiable output.** The guard's report for the package.

#### L23: first-party capacity providers and traits in the relay (`@hobo/ci-gh-actions`, second pass)

- **Scope in.** Capacity providers for the box worker, a local box and Kubernetes (ARC scale set and isolated pod) with their config schemas (`scaleSet`, `engine`, the local label rule); `src/hosted-runtime.ts`, `src/relay-cache/store.ts`, `relay-cache/rebuild.ts`, `src/isolated-backend.ts`, `isolated-worker/composite-host.ts`, `lease-reconciler.ts`, `container-controller.ts`, `live-container-count.ts`, `src/hosted-control.ts` L469-477; tests.
- **Acceptance.** Every existing test in the package passes unchanged in what it asserts. The Kubernetes provider's `normalizeLegacy` accepts today's `scaleSet` and `engine` spelling. The guard reports 0 for these files.

#### L24: accounting, observations, enforcement and routes (`@hobo/ci-gh-actions`, third pass)

- **Scope in.** `src/hosted-relay.ts` and `queued-job-repair.ts` (external assignment through the catalog's selector lookup); `src/hosted-control.ts` (`POST /v2/accounts/self/observations` accepts `AccountObservation` and a verified workload identity; a client method `postObservation` in `client.ts`); admission enforcement of requirements with real facts; `GET /v1/fleet/routes/{owner}/{repo}` kept and served like a verdict, with the reason `budget` added to the verdict record; retirement of the `HOBO_CI_FLEET_ROUTES` variable publisher in `fleet-routes.ts`; reconciliation and drift; rebuild after cache loss; pacts for the new routes; the CloudEvents of section 6.15; `packages/ci/RUNNER-QUEUE.md`.
- **Acceptance.** A job on a rented selector produces an intent, a running lease and a settled lease with exact base units. An observation from a wrong repository, ref or workflow is refused with 404. A forged or expired one changes nothing. F3, F7, F12 and F17 each have a test. Provider pact tests for both routes are green.
- **Verifiable output.** The relay pacts and the F-row tests.

#### L25: the CLI (`@hobo/hobo`, second pass)

- **Scope in.** `src/can-deploy-command.ts` and `verify-command.ts` (the fleet pack through the Gatekeeper's policy gate, section 6.11); `src/ci-connect.ts` (descriptor-driven, section 6.12); `src/ci-command.ts` (`hobo ci observe`, `hobo ci lock`, `hobo ci fleet`, `hobo ci fleet explain`; the provider list in help comes from the catalog); `src/ci-serve.ts` (engines from the registry); tests and the help text in `packages/cli/src/shell/verbs.ts` as a cascade delta.
- **Scope out.** `src/ci-relay-deploy.ts`: the relay's own hosting target is its Yard's concern, not a CI provider, and is on the guard's exemption list with that reason.
- **Acceptance.** The golden verdict file (M7). The leak test (M15) over every new command. `hobo ci lock` is deterministic and its output validates against its schema. `hobo ci connect acme` works for the reference third-party provider with no code naming it.
- **Verifiable output.** `ci-fleet-verdicts.json` and the lock file schema.

#### C1: scripts, actions and workflows (coordinator)

- **Scope.** `scripts/ci/route-runner.mts` and its tests (members from the lock file, requirement evaluation, the relay's routes, the `budget` reason, shadow mode); `.github/actions/route-runner/action.yml` (sparse checkout adds the lock file and `fact-requirement.ts`); `scripts/lint-actions.ts` (allowed labels and probe selectors come from the lock file; a job may not name a rented selector directly); `fleet-probe.yml`; `fleet-observe.yml` and its entry in the approved set; the route job added to `fleet-enrollment.yml`, `dev-env-smoke.yml`, `examples-e2e.yml`, `ci-deps-publish.yml` and `hobo-ci-acceptance.yml`; the toolchain marker in `hosted-toolchain.sh`, `hobo-checkout`, `hobo-repo-checkout` and `pnpm-store`; a lock-file freshness step; the guard switched to enforcing.
- **Acceptance.** `scripts/test/route-runner.test.ts` covers twelve members, every row of the decision table in section 6.10, and F1, F2, F10, F13 and F18. M14 holds. `pnpm run ci:provider-literals` exits non-zero on a planted literal and zero on the tree (M1).

#### C2: configuration, documents and floors (coordinator)

- **Scope.** `.hobo/ci.json` as in Appendix B, with `routing.mode: "shadow"`, and the generated `.hobo/ci.lock.json`; `packages/conformance/src/boundaries.ts` (two exceptions removed); coverage floors for the new packages; `cli.ts` registrations; regenerated `site/src/pages/ci/providers.md`, `fleet-balancing.md` and the status page; `docs/design/ci-fleet-balancing.md`, `provider-manifest.md`, `extension-points.md`, the ADR-0178 and ADR-0180 amendments; `packages/hobo/CI.md`; a finding for each row of section 2; runbooks for connecting a provider, a stale balance, a drift alarm and taking a provider out; the plans index.
- **Acceptance.** M19 and M27. `hobo can-deploy` on the repository returns the verdicts of M7.

#### C3: deploy, connect and prove (coordinator and owner)

- **Scope.** Phases 1 to 4 of section 6.16; the owner inputs of section 10; one finding that records, per provider, the probe pickup, the acceptance run, the lease and the reconciliation figures; the scorecard regenerated with no `not-implemented` row.
- **Acceptance.** M21 to M26 for every connected provider. Every other provider's row reads `blocked-on-credentials` and names exactly what is missing.

## 10. Owner inputs

None of these blocks dispatch. Each has a default, and each only moves a scorecard row from `blocked-on-credentials` to `pass`.

| # | Input | Default if not given |
| --- | --- | --- |
| O1 | Install the Blacksmith and Depot GitHub Apps on `Hobo-Labs` with HoBo selected | The provider stays registered and unrouted (F1) |
| O2 | In the organization's Default runner group, keep "Allow public repositories" on | Kept on: HoBo's own runners, Depot and WarpBuild need it for this repository. Jog is then refused organization-wide, which can-deploy states |
| O3 | Install Jog only where its rule holds (an account whose sources are private) | Jog stays registered and refused for this repository |
| O4 | The plan each account is on, and the remaining included usage and credit shown in each dashboard, entered at `hobo ci connect` | The plan's full monthly grant is assumed for an existing subscription and marked `attested` with a seven-day validity |
| O5 | A read-only Boat API key and a Jog personal access token, captured into the secret store | Those providers use entered balances |
| O6 | Optional tokens for Depot, Blacksmith, Lizard and GitHub billing | `engine-derived` balances |
| O7 | An Infisical identity `hobo-ci-observer` (GitHub Actions OIDC on `main`, read-only on the balance folder) | The observe job posts token-free observations only |
| O8 | Boat, Lizard and WarpBuild accounts | Those providers are built, contract-tested and `blocked-on-credentials` |
| O9 | The cash ceiling for the `ci` environment | It stays at the authored 5,000,000 micros. Included usage and prepaid credit are spent first and do not count against it |

## 11. Assumptions to check first

Each is checked by the layer named before it writes code. If one is false, the layer reports a requirement change instead of working around it.

| # | Assumption | Checked by | If false |
| --- | --- | --- | --- |
| A1 | Adding exports and a data model to `@hobo/core` passes its surface guard as a deliberate, additive change | L01 | Put the ports in a new contract-layer package and classify it in `boundaries.ts` (coordinator) |
| A2 | Which host owns the account's configuration store in the Hobo-Labs deployment, the box or the hosted relay | L24 | The observation route is served by the relay core either way; only the runbook changes |
| A3 | A rented runner reports `runner.environment` as `self-hosted` | C1, from the first probe's log | The toolchain marker change is still correct; no change |
| A4 | Depot's billable seconds are already weighted by machine size | L09, against the API reference | Apply the weight when deriving |
| A5 | The JSON field names of `blacksmith usage` and `lizard billing status` | L08, L12, from the vendor reference or a recorded sample | Ship the `cli-json` source disabled and keep `engine-derived` |
| A6 | Lizard's Small and Large labels follow the pattern of `lizard-medium-ubuntu-2404` | L12 | Model the Medium offering only |
| A7 | The engine's event carries enough to know a source's visibility and owner type without an extra call | L21 | Use the 10-minute cached lookup `fleet-routes.ts` already makes |
| A8 | The organization's Default runner group setting can be read by the relay's GitHub App | L21 | The fact is declared in the policy and checked at connection |
| A9 | This work changes production packages only and needs no new draft proof | C0, against `references/planning.md` | Add the proof artifacts the draft skill names to the affected layers |
| A10 | The routing stack's route job reads `.hobo/ci.json` from its sparse checkout | C1 | Add the file to the checkout list |

## 12. Considered and rejected

| Option | Why not |
| --- | --- |
| Add `jog`, `boat` and `lizard` to the existing lists | It makes the docs true and keeps the defect: a fourth provider is again a core edit that older relays reject. It breaks R1 |
| A new Gatekeeper gate for the fleet | The gate list is closed, so it would be a core edit for every future dimension. A policy pack through the existing gate needs none |
| A new requirement language | One exists and is evaluated in production code (fact 7). A second would diverge |
| Declared facts only | A declared fact can be wrong. The relay and the route job use real facts and report a mismatch |
| The relay reads every provider's API | It would put provider SDKs, CLIs and third-party plugin code inside a stateless hosted function. A job with a read-only identity is the smaller trust surface |
| Token-backed balances by default | Three providers' tokens are not read-only. The default must work with no stored secret (R9) |
| Charging a plan's fee to the job that first uses it | The owner already pays for these accounts; a connection is an existing subscription |
| Publishing routes in a repository variable | Plan 0025 retired that transport for fleet state. The lock file carries configuration and the relay carries state |
| Routing each job of a run separately | One label per run keeps a run's caches and toolchain on one kind of machine and keeps plan 0025's decision. Spreading runs relieves the queue |
| Keeping the three hand-declared runner packages as they are | AGENTS.md requires generated records, and the banked boundary exceptions must shrink |
| Dropping the modelled sandbox providers until they have drivers | R7. They move to the catalog as `held`, with every figure kept |

## Appendix A: provider dossiers

Read on 2026-11-12. "Not documented" means the pages read do not say; the implementer resolves it from the vendor's page or leaves it out of the model.

### A.1 Jog

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `jog` (2 vCPU) $0.0012 a minute; `jog-4vcpu` $0.0024; `jog-8vcpu` $0.0044; `jog-16vcpu` $0.0088; `jog-32vcpu` $0.0176. `jog-max` and `jog-max-4vcpu` to `-32vcpu` at twice the rate | usejog.com/docs/pricing/, /docs/runners/ |
| Billing | Per second, no minimum. No subscription. Prepaid credits, $100 to $50,000. Auto top-up of $100 below $10 | /docs/pricing/ |
| Included | 5,000 minutes a month "while you have credits", used first; a 4 vCPU minute counts twice, 8 vCPU four times | /docs/pricing/ |
| Restrictions | No public repositories. No macOS, Windows, ARM, GPU or ubuntu-22.04. An organization's Default runner group must not allow public repositories and must not be limited to selected repositories. New organizations may wait on a waitlist | /docs/runners/ |
| Exhaustion | "A job fails at start when its account has no credits loaded or is out of credit" | /docs/runners/ |
| Sign-in | Jog's GitHub App, repositories chosen on GitHub's install screen. No runner token | /docs/runners/ |
| Usage API | `GET /api/orgs/{org}/advice/runs`: `seconds`, `cost` (micro-dollars), `outcome`, `size`. Header `Jog-Route-Version: 4`. Bearer `jog_pat_…` from /account/-/tokens (7, 30 or 90 days) or the device flow. The token "reads nothing else on Jog: no money, settings, logs or other pages" | /docs/api/ |
| Not documented | A balance endpoint, fork pull requests, concurrency, maximum runtime | |

### A.2 Blacksmith

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `blacksmith-<N>vcpu-ubuntu-2404` and `-2604`, N in 2, 4, 8, 16, 32 (8 to 128 GB); `-arm` variants; Windows and macOS labels | docs.blacksmith.sh/blacksmith-runners/overview |
| Rate | $0.004 a minute for x64 2 vCPU; larger sizes in proportion | blacksmith.sh/pricing |
| Included | "3000 x64 2vCPU minutes for free per month per organization". An ARM 2 vCPU minute counts 0.625, a Windows one 2 | /blacksmith-runners/overview |
| Restrictions | The GitHub App is the integration with an organization. "Blacksmith has no concurrency limits" | /blacksmith-administration/github-app, /blacksmith-runners/concurrency |
| Sign-in | GitHub App only: "there are no PATs, deploy keys, or other standing credentials involved" | /blacksmith-administration/github-app |
| Usage | CLI `blacksmith usage` (`--since`, `--start-time`, `--end-time`, `--breakdown-by`, `--format json`): billable minutes, billing minutes, runtime minutes, estimated cost. Organization token from `blacksmith org-token create`; non-interactive login `blacksmith auth login --api-token - --non-interactive --organization <slug>` | /blacksmith-cli/usage, /blacksmith-cli/overview |
| Token scope | Organization-wide, including shutting machines down and managing caches | /blacksmith-cli/overview |
| Not documented | An HTTP API, the JSON field names, remaining free minutes, spend limits, personal accounts, public repositories, fork pull requests | |

### A.3 Depot

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `depot-ubuntu-24.04[-arm][-<vCPU>]`, sizes 2 to 64 vCPU (8 to 256 GB); Windows and macOS labels | depot.dev/docs/github-actions/runner-types |
| Rate | $0.006 a minute for the base 2 vCPU Linux runner; multipliers 1, 2, 4, 8, 16, 32. Tracked per second | /pricing, /docs/github-actions/overview |
| Plans | Developer $20 a month with 2,000 minutes; Startup $200 with 20,000; Business custom. "Included monthly minutes are not a hard cap" | /pricing |
| Restrictions | "Depot GitHub Actions runners only support repositories owned by GitHub organizations". A public repository needs "Allow public repositories" on the GitHub runner group. "No concurrency limits" | /docs/github-actions/overview, /quickstart |
| Sign-in | Connect the organization in the dashboard and install the Depot GitHub App; the owner role is required | /docs/github-actions/quickstart |
| Usage API | `POST https://api.depot.dev/depot.core.v1.GithubActionsService/GetGithubActionsUsageProjection`, Connect JSON, header `Connect-Protocol-Version: 1`, bearer organization token. Answer: `periodStart`, `periodEnd`, `dataThrough`, `actualBillableSeconds`, `projectedBillableSeconds`, `actualCost`, `projectedCost`, `currency`. Cost excludes discounts and credits | /docs/api/github-actions-api |
| Token scope | The organization token "can create, update, and delete projects and run builds". OIDC trust relationships are documented for builds, not for this API | /docs/api/authentication, /docs/cli/authentication |
| Not documented | A remaining-balance figure, fork pull requests, a current usage cap for runners | |
| Repo discrepancy | `packages/providers/runner-depot` prices the runner at 0.0040; the pricing page says $0.006 | |

### A.4 Boat

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `boat-small` (2 vCPU, 4 GB) $0.018 an hour; `boat` (4, 8) $0.036; `boat-large` (8, 16) $0.072; `boat-xlarge` (16, 32) $0.200, needs the $100 plan | docs.boat.dev/ci, /pricing.md |
| Plans | $20, $100, $500, $2,000 a month. "Every dollar comes back as VM time"; $20 includes 555 hours of the default machine. CI needs the $20 plan or higher | /pricing.md, /billing.md |
| Limits | Six hours a job. Starts per minute, hour and day and machines at once: 12, 60, 200 and 100 on $20; 30, 210, 840 and 300 on $100 | /ci, /limits.md |
| Restrictions | Jobs from public repositories "do not run on boat by default"; turned on per GitHub account with `boat ci public`. `--anyone` also lets fork pull requests run | /ci |
| Exhaustion | After included time, a 24-hour grace period, then running machines stop; extra starts fail | /billing.md |
| Sign-in | `boat ci connect` (`--org`), a GitHub App that needs Administration: write; or "Boat CI for orgs" | /ci |
| Balance API | `GET https://boat.dev/api/v1/limits`: `wallet.balanceDollars`, `planIncluded.vmHours`, `vmHoursRemaining`, `periodEnd`, `canStart`, `starts.*`, `billingStatus`. `GET /api/v1/ci`: per job `runSeconds`, `costDollars`, `state` | /api/v1.md and the reference pages |
| Key | `boat api-key create <name> --preset read-only`; scope `account.read`; 90 days by default, 365 at most | /api-keys/scopes.md |

### A.5 Lizard

| Item | Value | Source |
| --- | --- | --- |
| Offerings | Small (2 vCPU, 4 GB) $0.00027 a minute; Medium (4, 8) $0.00054; Large (8, 16) $0.00108. Example label `lizard-medium-ubuntu-2404` | lizard.build/ci |
| Plans | Pro $19 a month "with $19 of usage included"; Pro 5x $99; Pro 20x $499. "There is no spending cap" | /ci, /docs/platform/billing.md |
| Restrictions | GitHub App on an organization: "Personal accounts aren't supported yet". Linux x64 Ubuntu 24.04 only. Trial: 8 vCPU at a time | /ci |
| Usage | CLI `lizard billing status --json`: plan, usage left, included usage used, overage, next charge | /docs/cli/billing.md |
| Not documented | Small and Large labels, a REST usage endpoint, the key's scope, maximum runtime, public repositories, fork pull requests | |

### A.6 WarpBuild

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `warp-ubuntu-latest-x64-<N>x`, `warp-ubuntu-2404-x64-<N>x`, also 2604 and 2204; N in 2, 4, 8, 16, 32 at $0.004, $0.008, $0.016, $0.032, $0.064 a minute | warpbuild.com/docs/ci/cloud-runners, /pricing |
| Restrictions | "WarpBuild needs a GitHub organization. It cannot be installed on a personal account." A public repository needs the GitHub runner group to allow it. Unlimited concurrency on generally available Linux runners | /docs/ci/quick-start, /docs/ci/cloud-runners |
| Sign-in | GitHub App; one organization to one workspace | /docs/ci/quick-start |
| Not documented | Free credit amount, a plan fee, machine memory, a usage API, fork pull requests | |

### A.7 GitHub-hosted

| Item | Value | Source |
| --- | --- | --- |
| Offerings | `ubuntu-24.04` standard; larger runners by name | docs.github.com billing pages |
| Rate | Linux 2-core $0.006 a minute, 4-core $0.012. Standard runners are free on public repositories | /billing/reference/actions-runner-pricing |
| Included | A monthly dollar amount per plan: Free $12, Team $18, Enterprise Cloud $300 | /billing/concepts/product-billing/github-actions |
| Exhaustion | Without a payment method, "usage is blocked once you consume the included compute usage"; a budget can stop usage | same |
| Usage API | `GET /organizations/{org}/settings/billing/usage` (`usageItems`: `sku`, `quantity`, `grossAmount`, `netAmount`); budgets at `/settings/billing/budgets`. An organization administrator is required | /rest/billing/usage, /rest/billing/enhanced-billing |
| Not documented | Whether an App installation token may call the usage endpoint; concurrency per plan (the repo models 20) | |

## Appendix B: target `.hobo/ci.json` for this repository (the `ci` environment)

```json
{
  "facts": {
    "work.source.visibility": "public",
    "work.owner.kind": "organization",
    "scope.default-pool.public-sources": "allowed"
  },
  "engines": { "gh-actions": { "webhookOrigin": "https://hobo-ci.vercel.app" } },
  "connections": [
    { "id": "blacksmith", "kind": "blacksmith", "enabled": true, "flow": "app-install", "plan": "free" },
    { "id": "depot", "kind": "depot", "enabled": true, "flow": "app-install", "plan": "developer" },
    { "id": "jog", "kind": "jog", "enabled": false, "flow": "app-install" },
    { "id": "boat", "kind": "boat", "enabled": false, "flow": "boat-ci-connect",
      "facts": { "account.public-sources": "disabled", "account.external-contributions": "disabled" } },
    { "id": "lizard", "kind": "lizard", "enabled": false, "flow": "app-install" },
    { "id": "warpbuild", "kind": "warpbuild", "enabled": false, "flow": "app-install" }
  ],
  "policy": {
    "routing": { "strategy": "maximize-credits", "mode": "shadow",
                 "noEligibleProvider": "queue", "unknownAllocation": "zero" },
    "providers": [
      { "id": "vercel-sandbox", "kind": "vercel", "connectionRef": "vercel-sandbox",
        "offering": "sandbox", "enabled": true, "config": { "location": "vercel" } },
      { "id": "oracle-free-isolated", "kind": "hobo-box-worker", "connectionRef": "oracle-free-vm",
        "offering": "isolated-worker", "enabled": true },
      { "id": "hostinger-arc", "kind": "kubernetes", "connectionRef": "hostinger-arc",
        "offering": "scale-set", "enabled": false,
        "config": { "selector": "hobo-arc",
                    "scaleSet": { "name": "hobo-arc", "namespace": "arc-runners", "minRunners": 0, "maxRunners": 4 } } },
      { "id": "blacksmith", "kind": "blacksmith", "connectionRef": "blacksmith",
        "offering": "x64-4vcpu-ubuntu-2404", "enabled": true },
      { "id": "depot", "kind": "depot", "connectionRef": "depot",
        "offering": "x64-4vcpu-ubuntu-2404", "enabled": true },
      { "id": "jog", "kind": "jog", "connectionRef": "jog", "offering": "x64-4vcpu", "enabled": false },
      { "id": "boat", "kind": "boat", "connectionRef": "boat", "offering": "default", "enabled": false },
      { "id": "lizard", "kind": "lizard", "connectionRef": "lizard", "offering": "medium", "enabled": false },
      { "id": "warpbuild", "kind": "warpbuild", "connectionRef": "warpbuild",
        "offering": "x64-4x", "enabled": false },
      { "id": "github-hosted", "kind": "github", "connectionRef": "github-hosted",
        "offering": "ubuntu-24.04", "enabled": true }
    ]
  }
}
```

With these facts `hobo can-deploy` admits Blacksmith, Depot and GitHub-hosted and reports Jog as refused. Enabling Jog here turns the command's answer to no, with Jog's statement. The plan names (`free`, `developer`) are the defaults of O4; the owner's real plans replace them at connection.

## Appendix C: where provider and engine names are today

One hit is one quoted literal equal to a provider name (github, blacksmith, depot, warpbuild, kubernetes, hobo-box-worker, local, vercel, azure-devops, dagger, cloudflare, jog, boat, lizard, agent37, modal, daytona, e2b, northflank, freestyle, blaxel, runloop) or an engine name (gh-actions, ado, dagger, cf, sandbox, isolated-container). Classes: LIST (a closed set), PAIR (a rule pairing a provider with a backend or label), BEHAVIOR (a branch whose behaviour differs by name), DATA (a per-provider table).

| Package | Files | Hits | Main files (hits, class) | Layer |
| --- | --- | --- | --- | --- |
| `packages/ci` | 18 | 145 | `config.ts` (37, LIST and PAIR); `fleet/models.ts` (25, DATA); `ci.cue` (17, LIST and PAIR); `policy.ts` (16); `fleet-overflow.ts` (13, BEHAVIOR); `sqlite-store.ts` (7); `routing.ts` (6); `store.ts` (4); `fleet-v2/parse.ts` (4); `provider-allocation.ts` (3); `fleet/offers.ts` (3) | L06, L16, L22 |
| `packages/ci-gh-actions` | 26 | 132 | `runner-integrations.ts` (12, LIST and DATA); `relay-cache/store.ts` (10) and `rebuild.ts` (10, BEHAVIOR); `hosted-runtime.ts` (10); the provider schema (10, generated); `project-providers.ts` (9); `act-harness.ts` (8); `acceptance.ts` (8); `composite-host.ts` (6); `isolated-backend.ts` (6); `ci-engine-inventory.ts` (6); `onboarding.cue` (6) | L21, L23, L24 |
| `packages/ci-vercel` | 4 | 6 | `sandbox-composition.ts` (3, PAIR and BEHAVIOR) | L17 |
| `packages/ci-dagger` | 6 | 11 | Its own id | L19 |
| `packages/ci-cf` | 7 | 9 | Its own id | L20 |
| `packages/ci-ado` | 1 | 1 | Its own kind | L18 |
| `packages/hobo/src` | 4 | 12 | `ci-relay-deploy.ts` (4, exempt); `ci-command.ts` (4); `ci-serve.ts` (2); `ci-connect.ts` (2) | L25 |
| `scripts/ci` | 7 | 113 | `route-runner.mts` (14, tiers); `attested-jobs.json` (93, not providers) | C1 |

Totals: 73 files and 429 hits; without the hits that are not providers, about 57 files and 312 hits. Tests: 115 files and 588 hits, owned by the layer that owns their package. Fixtures: 42 files and 55 hits.

**The guard's exemptions** (at most 12, each with its reason in the script): a provider's own name inside its own package; `scripts/ci/attested-jobs.json` (attestation mode, not a provider); `GITHUB_RUN_ID ?? "local"` and like fallbacks; the Dagger engine location `engine: "local"`; `packages/hobo/src/ci-relay-deploy.ts` (the relay's own hosting target).

## Appendix D: swarm schedule

For each wave, start one pipeline per layer, at most one per package:

1. **Implement.** One implementer in its own worktree on `sdlc/ci-catalog-<layer>-<slug>`, given the layer's body, the sections it cites, section 9.3 and the dossier it needs.
2. **Review.** One read-only reviewer re-runs the package gate and checks the acceptance list and the rows of sections 7 and 8 that name the layer.
3. **Verify.** The coordinator applies cascade deltas, runs `pnpm run ci:provider-literals` and the scorecard generator, and records the result in the state file.

A layer that fails review returns to its implementer with the findings. A wave closes when every layer in it has passed all three steps. The coordinator merges bottom-up within each lane, then starts the next wave. Waves 0 and 9 are the coordinator's own.
