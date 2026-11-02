# HoBo

**HoBo is a design-first meta-cloud project for deploying one application shape onto many real infrastructure shapes.**

A developer or agent should be able to describe an app once, then let HoBo place it on a provider, mix of providers, or self-hosted yard without rewriting app code. The design uses **WIT/WASM Component Model interfaces** as the portable membrane, provider adapters as the integration boundary, and an event-sourced control plane as the operating model.

> **Current state:** `@hobo/*` is **not on npm** — do not run `npx hobo` (that name is a different package). Clone this repo, `pnpm install`, and use the composed `@hobo/hobo` binary after a workspace build (`pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo`). Active design + executable contract/proof repository with a production `packages/` workspace (**127** package manifests under `packages/`; ~249k non-test TypeScript lines under `packages/*/src` excluding generated clients: core, wit, bindles, runtime, runtimes/*, dispatcher, trails, stations, storage-sqlite, broker, connectivity, componentize, conformance, cli, hobo, code, cloud, replay, identity, mcp, contracts, policy, data, events, camps, yards, junctions, control-api, control-yard, management, iac/*, providers/* (incl. provider-convex), connectors/*, adapters/*, schema-tools, stage-gate, ci-guard, contract-harness, training-pipeline). All **42** canonical `hobo` CLI verbs (`packages/cli/src/shell/verbs.ts`) dispatch against the local lane; the product binary is **`@hobo/hobo`** (composition root), while **`@hobo/cli`** provides the shell and command factories. Default deploy uses an **in-memory Pulumi stand-in** (`HONEST SCOPE` in `packages/hobo/src/compose.ts`); live Vercel/Cloudflare and `HOBO_PULUMI_LIVE=1` are credential- or engine-gated. `@hobo/componentize` ships a **real jco/`componentize-js` lane** (`createRealComponentize`, opt-in via `HOBO_COMPONENTIZE_REAL=1`, fail-closed when the toolchain is absent) with the **synthetic contract bytes** (`buildWasmContractBytes`) as the offline default floor. Hierarchical DNS-valid naming, optional local named endpoints, overlay/DNS/policy/metering foundations live in `@hobo/connectivity` ([ADR-0130](./docs/design/adr/07-portability-extensibility.md#adr-0130)). **Pre-release:** packages are **not published to npm**. Ship targets A/B/C: [`docs/design/launch-ship-targets.md`](./docs/design/launch-ship-targets.md), [ADR-0140](./docs/design/adr/07-portability-extensibility.md#adr-0140); gap review [`docs/plans/0011-ship-readiness-gap-review.md`](./docs/plans/0011-ship-readiness-gap-review.md); remediation [`docs/plans/0012-ship-remediation-plan.md`](./docs/plans/0012-ship-remediation-plan.md).

**Website:** the landing page, developer docs, and agent docs live at **<https://tyler-r-kendrick.github.io/HoBo/>** — source in [`site/`](./site/README.md), published by pushing the built `site/dist/` to the `gh-pages` branch (no Actions dependency; see the site README for the publish commands).

## HoBo.CI

[HoBo.CI](./packages/ci/README.md) adds allocation-first CI routing as sibling SDK packages.
The [GitHub Actions service](./packages/ci-gh-actions/README.md) supports `runs-on: hobo`
with an authenticated account API, durable policy, repository setup PRs, JIT runner
hosts and Compose/Kubernetes deployment assets. GitHub, Blacksmith, Depot, WarpBuild
and operator-owned hosts share allocation-first budget routing. Dagger and Cloudflare
CI implement the same portable pipeline contract. Connected `act` acceptance and an
actual container lifecycle test verify local execution and deployment; the manual
HoBo workflow separately verifies real GitHub runner assignment.
The [Vercel package](./packages/ci-vercel/README.md) also runs Vercel CI-tagged
Turbo checks locally with `pnpm ci:local`; keep hosted CI disabled to avoid
Vercel CI compute charges.

## Why HoBo exists

Modern app teams still choose between two bad defaults:

1. **Closed PaaS:** easy deploys, but lock-in and limited escape hatches.
2. **Raw cloud/IaC:** full control, but every app team becomes a platform team.

HoBo's goal is a third path: **cloud portability without hiding the cloud**.

- Start with provider-agnostic application intent.
- Let HoBo choose or reconcile infrastructure from policy, cost, compliance, and reliability goals.
- Drop down to typed provider-specific options when optimization matters.
- Keep humans and AI agents on the same authenticated, auditable control surface.

## Core ideas

| Idea | Meaning |
|---|---|
| **Bindle** | Application package/topology: services, resources, wiring, policies, and deployment intent. |
| **Camp** | Deployment target that hosts workloads and durable runtime ports. **Provider-neutral until attached to a Yard**; provider is inferred from the Yard. Camps can move between Yards via **Trails**. |
| **Yard** | Provider-specific control scope spanning Camps, policy, identity, and reconciliation. **Owns provider selection.** |
| **Junction** | Cross-Yard federation layer for hybrid or multi-cloud operation. |
| **Trail** | App-owned continuous migration recipe; owns how Camps re-home across Yards/clouds (not Camp-local provider pins). |
| **Station** | Hard control-plane isolation boundary (tenant/residency/air-gap/trust domain) a Conductor occupies; Rails pin its active policy; hosts the routing control loop + progressive cutover + offering registry. |
| **Trait** | Declaratively attached operational behavior (`.allow()`, annotations, policy packs, Workload Profiles, …) anchored on the manifest `annotations` block ([ADR-0145](./docs/design/adr/01-architecture-core.md#adr-0145)). |
| **Jurisdiction & residency** | Typed legal geography: region→jurisdiction catalog, per-tenant residency constraints, and a fail-closed `evaluateResidency` gate ([ADR-0146](./docs/design/adr/02-identity-security.md#adr-0146)). |
| **WIT/WASM membrane** | Portable contract between app code, runtime ports, and provider adapters. Latest stable TypeScript is the first implementation language; Protobuf, CUE, and PACT pin data contracts and boundary compatibility. |
| **Ports and adapters** | Cloud providers, IaC engines, build tools, identity systems, and AI optimizers sit behind replaceable ports. |
| **Replayable event log** | Control-plane state, projections, SRE workflows, and audit trails derive from events. |
| **Agent-native auth** | AI agents are first-class principals with scoped credentials, policy checks, and traceable actions. |
| **Named endpoints** | HoBo-owned DNS-valid hierarchy (`.hobo.localhost` / `.hobo.test`); optional local portless HTTPS; overlay + pluggable public DNS. |
| **Multi-tenant foundations** | Tenant-scoped models, `PolicyEngine`, and metering `UsageEvent` hooks — SaaS/billing/policy language as natural extensions. |

Canonical terminology lives in [`docs/design/glossary.md`](./docs/design/glossary.md). The high-level design starts in [`docs/design/vision.md`](./docs/design/vision.md). Connectivity deep-dive: [`packages/connectivity/README.md`](./packages/connectivity/README.md).

## Repository map

| Path | What it is |
|---|---|
| [`packages/`](./packages/) | The production TypeScript workspace — 127 package manifests (core/runtime/control-plane/providers/iac/runtimes/connectors/adapters); authoritative package ownership in [`docs/design/package-namespaces.md`](./docs/design/package-namespaces.md). |
| [`examples/`](./examples/README.md) | Runnable examples (hello-bindle, multi-cloud-shop, ci-runner-balancing, durable-agent, self-host-yard, try-site). |
| [`scripts/`](./scripts/) | Repo gates and tooling (architecture guard, standards/docs checks, staging cutover demo, codegen). |
| [`docs/`](./docs/index.md) | OKF bundle root for HoBo docs; `index.md` files provide directory listings and concept docs carry OKF frontmatter. |
| [`docs/design/`](./docs/design/index.md) | Current design suite: capability docs, ADRs, CLI spec, traceability, glossary, event-family catalog. |
| [`src/draft/`](./src/draft/) | Executable draft taxonomy: `technical-proofs/`, `exp-proofs/`, `epic-proofs/`, and `projects/`. These are draft fixtures, not a production product. |
| [`docs/design/proofs/`](./docs/design/proofs/) | Human-readable proof records linked to `src/draft/<kind>/<slug>` packages. |
| [`docs/implementation-plan.md`](./docs/implementation-plan.md) | Durable mirror of the Linear backlog structure. Linear remains live status source. |
| [`docs/plans/`](./docs/plans/index.md) | Audit/review logs and improvement plans from the `/improve` tooling. |
| [`GAPS.md`](./GAPS.md) | Long-running intent-alignment gap review register (Nomad × Aspire × Nitric × FinOps × agent-native); findings append per iteration. |
| [`docs/competitors/`](./docs/competitors/index.md) | Competitive analysis and positioning notes. |
| [`docs/standards/`](./docs/standards/index.md), [`docs/technologies/`](./docs/technologies/index.md), [`docs/patterns/`](./docs/patterns/index.md) | Reference material used by design decisions. |
| [`docs/archive/`](./docs/archive/) | Deferred or superseded planning artifacts. |
| [`AGENTS.md`](./AGENTS.md), [`docs/agent-tooling.md`](./docs/agent-tooling.md) | Repo-level agent instructions and local agent-tooling reference. |
| [`site/`](./site/README.md) | The GitHub Pages website (landing + developer docs + agent docs): a self-contained Astro project, built locally and pushed to the `gh-pages` branch (no Actions dependency; see the site README). |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`SECURITY.md`](./SECURITY.md), [`SUPPORT.md`](./SUPPORT.md), [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | GitHub community-health docs for contributions, vulnerability reporting, support, and conduct. |

## Suggested reading paths

### If you are new

1. [`docs/design/vision.md`](./docs/design/vision.md) — product intent, boundaries, and positioning.
2. [`docs/design/architecture.md`](./docs/design/architecture.md) — reference architecture and package layout.
3. [`docs/design/worked-example.md`](./docs/design/worked-example.md) — one app moving through the system.
4. [`docs/design/walkthrough.md`](./docs/design/walkthrough.md) — role-based flows for app dev, platform, GitOps, SecOps, DevOps, and SRE.

### If you are implementing a slice

1. Start from the relevant Linear issue or [`docs/implementation-plan.md`](./docs/implementation-plan.md).
2. Read the matching design doc in [`docs/design/`](./docs/design/index.md).
3. Check the corresponding proof note under [`docs/design/proofs/`](./docs/design/proofs/).
4. Apply the implementation architecture rules in [`AGENTS.md`](./AGENTS.md): PACT service boundaries, protobuf definitions with CUE constraints, parse-don't-validate derived types, and event-driven CQRS/actors/materialized views.
5. Update or add the `src/draft/<kind>/<slug>` proof package that proves the slice.
6. Update docs in the same change so the repo continues to describe reality.

### If you are reviewing architecture

- ADR index: [`docs/design/adr/index.md`](./docs/design/adr/index.md)
- Traceability gate: [`docs/design/traceability.md`](./docs/design/traceability.md)
- CLI surface: [`docs/design/cli-spec.md`](./docs/design/cli-spec.md)
- SDK contracts: [`docs/design/sdk-contracts.md`](./docs/design/sdk-contracts.md)
- Package namespaces: [`docs/design/package-namespaces.md`](./docs/design/package-namespaces.md)
- Influence lineage & credits: [`docs/design/lineage.md`](./docs/design/lineage.md)

## How to work in this repo

### Requirements

- Node.js ≥ 22 locally (`node:sqlite`); CI uses Node 24. `package.json` `engines.node` is `>=22`. `pnpm run setup` and the `pins:*` scripts run TypeScript with `--experimental-strip-types`, which needs Node ≥ 22.6 (22.22 prints no warning; older 22.x releases may print an ExperimentalWarning).
- pnpm through Corepack, using the checked-in `pnpm-lock.yaml`.
- Clone the git tree with submodules (`git clone --recurse-submodules …`; three packages of `external/ts-autocode`, `grounding`, `training` and `rewrite`, are workspace members). A GitHub zip without that submodule is incomplete, and `pnpm install` silently skips the missing packages until a build fails. A clone made without them is completed by `pnpm run pins:fetch` (a shallow fetch of exactly the pinned commit; add `-- --reference <local clone>` to download nothing that clone has), and `pnpm run setup` does the same before it installs. `pnpm run pins:status` says offline whether the checkout still matches its pin.
- Run the CLI as `pnpm hobo <verb> …` — the root script builds `@hobo/hobo` + `@hobo/adapter-hono` on first use. Fastest first success: `pnpm hobo dev --cwd examples/hello-bindle` serves a live local URL.

Everything HoBo takes from a sibling repository (the `ts-autocode` submodule today; the `mirror` and `opensesame-kit` executables once they publish releases) is pinned in [`tools/pins/siblings.json`](./tools/pins/siblings.json) and handled by one script with three verbs: `pnpm run pins:status` (offline drift check), `pnpm run pins:fetch [name…]` (obtain a pin) and `pnpm run pins:bump <name> <ref>` (move one). Every network wait they make is bounded by `HOBO_PINS_NET_TIMEOUT_MS` (default 120000 ms, at most 600000). See [ADR-0169](./docs/design/adr/01-architecture-core.md#adr-0169).

Install dependencies **first** (cold clones need this before most gates):

```sh
bash scripts/bootstrap-dev.sh --project-only
pnpm run install:check
pnpm run ci:preflight
```

Then confirm the workspace:

```sh
pnpm run doctor          # works offline; fails with next/hint until install; includes agent-tooling (AUTH/MCP/setup)
pnpm run agent:check -- --staged   # narrow staged gates after install
```

Without `node_modules`, `doctor` still runs health checks and prints install next steps; `agent:check` fails fast with the same install guidance (no `tsx` stack dump).

Lint workflow/package-manager wiring before pushing CI changes:

```sh
pnpm run actions:lint
```

General hosted GitHub Actions CI remains disabled to prevent unbudgeted spend. The sole active exception is the manually dispatched [HoBo runner acceptance workflow](./.github/workflows/hobo-ci-acceptance.yml), whose literal `runs-on: hobo` requires the budgeted relay. `pnpm run actions:lint` permits only that reviewed recipe and checks that every preserved legacy job remains disabled.

For a local release-quality verification pass, use `pnpm run verify:full`. The opt-in `pnpm run verify:extended` adds coverage, mutation, property, and fuzz testing.

Run the core local gate:

```sh
pnpm run architecture:guard
pnpm test
pnpm run standards:check
pnpm run docs:cli-lint
pnpm run docs:design-lint
pnpm run docs:coverage
pnpm run docs:okf
pnpm run docs:freshness
node --import tsx scripts/validate-sdk-contracts.ts
node --import tsx scripts/validate-deployment-set-delta.ts
```

(`scripts/validate-traceability.ts` is descoped from the blocking gate; traceability is covered by `docs:design-lint` and `konsistent`.)

The test runner shards tracked test files into bounded `node --test` batches,
prints full batch output only on failure, and uses smaller single-worker batches
on Windows so large worktrees exercise the same suites without exhausting local
process or terminal resources. Long-running batches print periodic progress so
local hooks stay observable while type-heavy fixtures compile. Set
`HOBO_TEST_TIMEOUT` to raise the default Vitest test and hook budgets on slow
mounted filesystems. The pre-commit hook leaves Git's hook environment (`GIT_INDEX_FILE`, and `GIT_DIR` in a linked
worktree) in place, because its gates must read the index being committed; tests
that build repositories of their own clear those variables themselves.

The repo pre-commit hook is installed for you: the root `prepare` script points `core.hooksPath` at `.githooks` on install, and the session-start hooks of Claude Code, Codex, Cursor and Copilot do it when it is unset (see [`docs/agent-tooling.md`](./docs/agent-tooling.md)). Set it by hand after an install that ran no lifecycle scripts:

```sh
npm run prepare-hooks
```

`.githooks/pre-commit` then runs, through `scripts/run-script.mts`, the generated-files guard (`generated:guard`) and the staged impact-routed gate (`check:relevant:staged`), which selects the relevant subset of the architecture guard, tests, technical standards, docs linters, and docs freshness for the staged diff before each commit. The root-script gates need Node and installed dependencies but no package manager. A change under a workspace package selects the turbo package-test lane, which runs package scripts through pnpm, and a few root scripts (such as `install:check`) call pnpm themselves; without pnpm those gates fail and the commit is refused. `npm run architecture:guard:staged` runs before the heavier test suite so missing PACT/protobuf/CUE/parse/event evidence is caught locally instead of burning CI.

## Technical standards

HoBo technical work is TypeScript-first and contract-first. New JavaScript-family code should use the latest stable TypeScript rather than vanilla JavaScript; integration and persistence boundaries use Protobuf contracts; invariants and dependent constraints live in CUE; parsed/refined derivative object definitions implement "Parse, don't validate"; and all integration boundaries need PACT-style consumer-driven contract coverage. Prefer compile-time, codegen, CUE, conformance, and contract-test feedback before runtime error discovery. The `standards:check` gate enforces the baseline across local hooks and CI by requiring the TypeScript toolchain metadata, preserving canonical Protobuf/CUE/PACT guidance, and blocking new JavaScript implementation files in favor of `.ts` sources. See [`docs/design/technical-standards.md`](./docs/design/technical-standards.md).

## Documentation maintenance policy

Docs are part of the product surface for this repository. Whenever code, automation, CI, package metadata, draft contracts, or agent tooling changes, the matching documentation must change too.

The `docs:freshness` gate enforces the minimum rule: changes under `src/`, `scripts/`, `test/`, package metadata, workflows, or agent config must include a docs update such as `README.md`, `AGENTS.md`, `docs/`, or a relevant proof/contract README. This follows GitHub maintenance best practice: keep the README accurate, make contribution expectations explicit, and use CI to protect project documentation from drifting behind code.

## CI and gates

General hosted GitHub Actions workflows remain disabled. The preserved workflow definitions under [`.github/workflows-disabled/`](./.github/workflows-disabled/) do not run. The sole definition in `.github/workflows/` is the manual HoBo runner acceptance recipe; it has no hosted fallback or automatic trigger. Checks that read a workflow definition, such as `ship:gap-closure`, look in both directories, so moving the definitions between them neither fails nor skips those checks.

Run the verification lanes locally:

- `pnpm run actions:lint` checks that no recognized workflow files exist and that preserved definitions remain valid.
- `pnpm run verify:full` runs the release-quality local validation lane.
- `pnpm run verify:extended` adds coverage, mutation, property, and fuzz testing.


The website is **not** CI-deployed: [`site/`](./site/README.md) is built locally and pushed to the `gh-pages` branch directly (GitHub Pages serves that branch), so publishing works even when Actions runs are unavailable.

Core checks are intentionally ordinary Node scripts so they run locally, in CI, and inside agent sessions. `docs:coverage` also checks that required GitHub community-health and maintenance docs stay present.

## AI agent workflow

This repo is configured for agent/harness-agnostic helper tooling first, with supported shims for Claude Code, Cursor, Codex, and GitHub Copilot CLI where those clients need their own files. Start with [`AGENTS.md`](./AGENTS.md) before editing. Full setup details, devcontainer bootstrap behavior, progressive per-agent setup, cross-agent sync rules, install commands, and data-egress risks are in [`docs/agent-tooling.md`](./docs/agent-tooling.md).

Important rules for agents and humans:

- Do not treat `src/draft/<kind>/<slug>` as production HoBo code; it is executable design proof material.
- Implement HoBo code through the architecture guardrails in [`AGENTS.md`](./AGENTS.md): PACT, protobuf, CUE, parse-don't-validate types, CQRS, event stores, materialized views, actors, rx-style projections, cached snapshots, and persisted historical read-store snapshots.
- Run `pnpm run architecture:guard` when implementation packages change; CI runs the same changed-package guard before the expensive build and test lanes.
- Keep docs, ADRs, proof notes, and README claims aligned with code changes.
- Prefer small, reviewable changes tied to a design claim or backlog slice.
- Run the local gates before opening a PR.

## Status summary

- **Product implementation:** **127** package manifests under `packages/` (~249k non-test TypeScript LOC under `packages/*/src`, excluding generated clients). All **42** canonical `hobo` CLI verbs are registered in `@hobo/cli` and composed by `@hobo/hobo` against the local lane. Default IaC is an **in-memory Pulumi stand-in** (not live cloud apply); see `HONEST SCOPE` in `packages/hobo/src/compose.ts`. Live-cloud lanes are credential- or engine-gated (`VERCEL_TOKEN`, Cloudflare tokens, `HOBO_PULUMI_LIVE=1`).
- **Pre-release / distribution:** `@hobo/*` packages are **not published to npm** (workspace `0.0.1`). Prefer installing from this monorepo until a publish allowlist and CI-proven release path land.
- **Componentize honesty:** `@hobo/componentize` has two lanes — the offline default builds **synthetic wasm contract bytes** (`buildWasmContractBytes`), and `HOBO_COMPONENTIZE_REAL=1` drives the **real jco/`componentize-js` pipeline** (toolchain-gated, fail-closed, real component-model binaries validated for wasm magic + component layer).
- **Migration & upgrade engine:** live executors ship in `@hobo/trails` (upgrade preflight evidence, expand→backfill→contract over a real SQLite store, pooled→siloed zero-loss tenant move, CDC data-dual ports) with the `migration.*` event family pinned in `@hobo/events`' append-only golden-replay corpus + upcaster-totality gate. See [`docs/design/upgrade-migration-engine.md`](./docs/design/upgrade-migration-engine.md).
- **Budget-driven routing:** `@hobo/dispatcher` (ADR-0071 deterministic credit/budget selection) + `@hobo/broker` budget signals + the `@hobo/stations` closed routing control loop and progressive cutover saga; rehearse the zero-downtime swap with `pnpm run staging:cutover` (loopback lane green with archived evidence; Vercel/Cloudflare lanes credential-gated fail-closed — [`docs/design/live-provider-matrix.md`](./docs/design/live-provider-matrix.md)).
- **Design suite:** active and canonical under [`docs/design/`](./docs/design/index.md); influence credits in [`docs/design/lineage.md`](./docs/design/lineage.md).
- **Ship targets:** OSS public vs local-first npm vs hosted beta/GA are distinguished in [`docs/design/launch-ship-targets.md`](./docs/design/launch-ship-targets.md) and [ADR-0140](./docs/design/adr/07-portability-extensibility.md#adr-0140). Readiness findings: [`docs/plans/0011-ship-readiness-gap-review.md`](./docs/plans/0011-ship-readiness-gap-review.md); remediation work packages: [`docs/plans/0012-ship-remediation-plan.md`](./docs/plans/0012-ship-remediation-plan.md). Known limitations: [`docs/design/known-limitations-register.md`](./docs/design/known-limitations-register.md).
- **Backlog mirror:** [`docs/implementation-plan.md`](./docs/implementation-plan.md); Linear is live operational source.
- **Executable proof material:** `src/draft/<kind>/<slug>` packages and repo validation scripts.
- **Primary command surface:** product `hobo` binary from [`packages/hobo/`](./packages/hobo/) (`@hobo/hobo`); shell/factories in [`packages/cli/`](./packages/cli/) (`@hobo/cli`). Spec: [`docs/design/cli-spec.md`](./docs/design/cli-spec.md). The same verb surface is served over MCP stdio by the `hobo-mcp` binary (`@hobo/hobo`), with verb/tool parity enforced by contract test.
- **Behavior suite:** epic proofs carry executable Gherkin — `pnpm run test:behavior` runs the cucumber lane (feature files under `src/draft/`).

## License

See [`LICENSE`](./LICENSE).
