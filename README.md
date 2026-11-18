# HoBo

**HoBo is a meta-cloud platform for deploying one application shape onto many real infrastructure shapes.**

A developer or agent should be able to describe an app once, then let HoBo place it on a provider, mix of providers, or self-hosted yard without rewriting app code. HoBo uses **WIT/WASM Component Model interfaces** as the portable membrane, provider adapters as the integration boundary, and an event-sourced control plane as the operating model.

> **Current state:** `@hobo/*` is **not on npm** — do not run `npx hobo` (that name is a different package). Clone this repo, `pnpm install`, and use the composed `@hobo/hobo` binary after a workspace build (`pnpm exec turbo run build --filter @hobo/adapter-hono --filter @hobo/hobo`). The production `packages/` workspace contains executable contracts and proof packages (including core, wit, bindles, runtime, runtimes/*, dispatcher, trails, stations, storage-sqlite, storage-postgres, cd, cd-gitops, cd-kube-fleet, resolver-components, broker, connectivity, componentize, conformance, cli, hobo, code, cloud, replay, identity, mcp, contracts, policy, data, events, camps, yards, junctions, control-api, management, iac/*, providers/* (incl. provider-convex), connectors/*, adapters/*, schema-tools, stage-gate, ci-guard, contract-harness, training-pipeline). All **42** canonical `hobo` CLI verbs (`packages/cli/src/shell/verbs.ts`) dispatch against the local lane; the product binary is **`@hobo/hobo`** (composition root), while **`@hobo/cli`** provides the shell and command factories. Default deploy uses an **in-memory Pulumi stand-in** (`HONEST SCOPE` in `packages/hobo/src/compose.ts`); live Vercel/Cloudflare and `HOBO_PULUMI_LIVE=1` are credential- or engine-gated. `@hobo/componentize` ships a **real jco/`componentize-js` lane** (`createRealComponentize`, opt-in via `HOBO_COMPONENTIZE_REAL=1`, fail-closed when the toolchain is absent) with the **synthetic contract bytes** (`buildWasmContractBytes`) as the offline default floor. Hierarchical DNS-valid naming, optional local named endpoints, overlay/DNS/policy/metering foundations live in `@hobo/connectivity`. **Pre-release:** packages are **not published to npm**.

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

## HoBo.CD

[HoBo.CD](./packages/cd/README.md) is the delivery sibling of HoBo.CI.
CI builds artifacts and can be any CI; CD moves immutable **Freight** through a
pipeline graph of Camps under policy and makes each Camp converge by **pull**.

- **Ingress from any toolset:** Freight sources poll OCI registries, Git hosts
  (smart-HTTP, no Git binary), package registries and HTTP indexes; any CI can
  push through OIDC trusted publishing or an in-toto/SLSA attestation.
  Webhooks only nudge a poll.
- **Lineage, windows and gates:** Freight reaches an environment only after
  qualifying upstream, every promotion is a Delta through the Gatekeeper, and
  change windows hold promotions and stage advances.
- **Every platform:** fenced per-Camp reconcilers (`conductor`, outbound-only
  `agent`, or a GitOps `publisher` for Argo CD and Flux) converge through
  HoBo's resolvers or out-of-tree `hobo:resolver` WASM components.
- **Verified and reversible:** progressive exposure lowered onto each Camp's
  real traffic capability, deterministic verification that fails on no data,
  and rollback as a Delta.
- **Fleets and policy:** deterministic Placement over Rail-bound Camp sets,
  group-by-group fan-out under a failure budget, governed failover, Rails
  delivered INFORM → ENFORCE, and continuous posture with OSCAL results.

Operate it with `hobo deploy`, `hobo serve cd` and `hobo incident`
(`packages/hobo/CD.md`); runbooks are in [`docs/runbooks/cd/`](./docs/runbooks/cd/index.md).
SQLite is the default journal; more than one `hobo serve cd` replica needs
PostgreSQL 16+ (`@hobo/storage-postgres`). HoBo dogfoods it: HoBo CI's hosted
relay, runner controllers and self-hosted runner fleets are to be delivered by
HoBo.CD, starting from the Freight sources `@hobo/cd/compose` already declares.

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

Core cloud hosting budget decisions use explicit effects and resilience, reserve
bounded commitments before activation, retain holds for unknown provider outcomes,
and require observations for recovery and retirement. The shared budget policy
applies the same financial authority to CI with explicit routing objectives,
workload metrics, and durable attempt and usage handling.

| Idea | Meaning |
|---|---|
| **Bindle** | Application package/topology: services, resources, wiring, policies, and deployment intent. |
| **Camp** | Deployment target that hosts workloads and durable runtime ports. **Provider-neutral until attached to a Yard**; provider is inferred from the Yard. Camps can move between Yards via **Trails**. |
| **Yard** | Provider-specific control scope spanning Camps, policy, identity, and reconciliation. **Owns provider selection.** |
| **Junction** | Cross-Yard federation layer for hybrid or multi-cloud operation. |
| **Trail** | App-owned continuous migration recipe; owns how Camps re-home across Yards/clouds (not Camp-local provider pins). |
| **Station** | Hard control-plane isolation boundary (tenant/residency/air-gap/trust domain) a Conductor occupies; Rails pin its active policy; hosts the routing control loop + progressive cutover + offering registry. |
| **Trait** | Declaratively attached operational behavior (`.allow()`, annotations, policy packs, Workload Profiles, …) anchored on the manifest `annotations` block. |
| **Jurisdiction & residency** | Typed legal geography: region→jurisdiction catalog, per-tenant residency constraints, and a fail-closed `evaluateResidency` gate. |
| **WIT/WASM membrane** | Portable contract between app code, runtime ports, and provider adapters. Latest stable TypeScript is the first implementation language; Protobuf, CUE, and PACT pin data contracts and boundary compatibility. |
| **Ports and adapters** | Cloud providers, IaC engines, build tools, identity systems, and AI optimizers sit behind replaceable ports. |
| **Replayable event log** | Control-plane state, projections, SRE workflows, and audit trails derive from events. |
| **Agent-native auth** | AI agents are first-class principals with scoped credentials, policy checks, and traceable actions. |
| **Named endpoints** | HoBo-owned DNS-valid hierarchy (`.hobo.localhost` / `.hobo.test`); optional local portless HTTPS; overlay + pluggable public DNS. |
| **Multi-tenant foundations** | Tenant-scoped models, `PolicyEngine`, and metering `UsageEvent` hooks — SaaS/billing/policy language as natural extensions. |

Connectivity details: [`packages/connectivity/README.md`](./packages/connectivity/README.md).

## Repository map

| Path | What it is |
|---|---|
| [`packages/`](./packages/) | The production TypeScript workspace — 144 package manifests (core/runtime/control-plane/providers/iac/runtimes/connectors/adapters). |
| [`examples/`](./examples/README.md) | Runnable examples (hello-bindle, multi-cloud-shop, ci-runner-balancing, durable-agent, self-host-yard, try-site). |
| [`scripts/`](./scripts/) | Repo gates and tooling (architecture guard, standards/docs checks, staging cutover demo, codegen). |
| [`docs/`](./docs/index.md) | OKF bundle root for HoBo docs; `index.md` files provide directory listings and concept docs carry OKF frontmatter. |
| [`src/draft/`](./src/draft/) | Executable draft taxonomy: `technical-proofs/`, `exp-proofs/`, `epic-proofs/`, and `projects/`. These are draft fixtures, not a production product. |
| [`docs/competitors/`](./docs/competitors/index.md) | Competitive analysis and positioning notes. |
| [`docs/standards/`](./docs/standards/index.md), [`docs/technologies/`](./docs/technologies/index.md), [`docs/patterns/`](./docs/patterns/index.md) | Reference material for the implemented platform. |
| [`AGENTS.md`](./AGENTS.md), [`docs/agent-tooling.md`](./docs/agent-tooling.md) | Repo-level agent instructions and local agent-tooling reference. |
| [`site/`](./site/README.md) | The GitHub Pages website (landing + developer docs + agent docs): a self-contained Astro project, built locally and pushed to the `gh-pages` branch (no Actions dependency; see the site README). |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`SECURITY.md`](./SECURITY.md), [`SUPPORT.md`](./SUPPORT.md), [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | GitHub community-health docs for contributions, vulnerability reporting, support, and conduct. |

## Suggested reading paths

Start with the runnable examples in [`examples/`](./examples/README.md), the
owning package README under [`packages/`](./packages/), and the repository rules
in [`AGENTS.md`](./AGENTS.md). Existing planning and design artifacts are being
completed and removed; user and operator documentation describes shipped behavior.

## How to work in this repo

### Requirements

- Node.js ≥ 22 locally (`node:sqlite`); CI uses Node 24. `package.json` `engines.node` is `>=22`. `pnpm run setup` and the `pins:*` scripts run TypeScript with `--experimental-strip-types`, which needs Node ≥ 22.6 (22.22 prints no warning; older 22.x releases may print an ExperimentalWarning).
- pnpm through Corepack, using the checked-in `pnpm-lock.yaml`.
- Clone the git tree with submodules (`git clone --recurse-submodules …`; three packages of `external/ts-autocode`, `grounding`, `training` and `rewrite`, are workspace members). A GitHub zip without that submodule is incomplete, and `pnpm install` silently skips the missing packages until a build fails. A clone made without them is completed by `pnpm run pins:fetch` (a shallow fetch of exactly the pinned commit; add `-- --reference <local clone>` to download nothing that clone has), and `pnpm run setup` does the same before it installs. `pnpm run pins:status` says offline whether the checkout still matches its pin.
- Run the CLI as `pnpm hobo <verb> …` — the root script builds `@hobo/hobo` + `@hobo/adapter-hono` on first use. Fastest first success: `pnpm hobo dev --cwd examples/hello-bindle` serves a live local URL.

Everything HoBo takes from a sibling repository (the `ts-autocode` submodule today; the `mirror` and `opensesame-kit` executables once they publish releases) is pinned in [`tools/pins/siblings.json`](./tools/pins/siblings.json) and handled by one script with three verbs: `pnpm run pins:status` (offline drift check), `pnpm run pins:fetch [name…]` (obtain a pin) and `pnpm run pins:bump <name> <ref>` (move one). Every network wait they make is bounded by `HOBO_PINS_NET_TIMEOUT_MS` (default 120000 ms, at most 600000).

Install dependencies **first** (cold clones need this before most gates):

```sh
bash scripts/bootstrap-dev.sh --project-only
pnpm run install:check
pnpm run ci:preflight
```

Then confirm the workspace:

```sh
pnpm run doctor
pnpm run agent:check -- --staged
```

Without `node_modules`, `doctor` still runs health checks and prints install next steps; `agent:check` fails fast with the same install guidance (no `tsx` stack dump).

Lint workflow/package-manager wiring before pushing CI changes:

```sh
pnpm run actions:lint
```

General hosted GitHub Actions CI uses the **HoBo CI Fabric** on self-hosted `hobo` runners (see [`.github/workflows/hobo-ci.yml`](./.github/workflows/hobo-ci.yml)). Release pipelines ([`release-hobo.yml`](./.github/workflows/release-hobo.yml), [`release-ts-autocode.yml`](./.github/workflows/release-ts-autocode.yml)) and the manual [HoBo runner acceptance workflow](./.github/workflows/hobo-ci-acceptance.yml) are registered in `scripts/lint-actions.ts`. Run `pnpm run actions:lint` before changing workflow YAML; it enforces SHA-pinned third-party actions, `runs-on: hobo` on active fabric workflows, and composite action pinning under `.github/actions/**`. Policy tests call the exported `lintActionsRepository()` in-process (not a subprocess per fixture) and set `HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY=1` so fixture trees are not slowed by per-invocation remote pin checks under CI contention.

The `actions lock` workflow verifies `.github/workflows/actions.lock` and uploads a patch when it needs updating. Its regeneration preserves full-SHA action pins; apply the patch and run `pnpm run actions:lint` before committing it.

For a local release-quality verification pass, use `pnpm run verify:full`. The opt-in `pnpm run verify:extended` adds coverage, mutation, property, and fuzz testing.

Run the core local gate:

```sh
pnpm run architecture:guard
pnpm test
pnpm run standards:check
pnpm run docs:cli-lint
pnpm run docs:links
pnpm run docs:coverage
pnpm run docs:okf
node --import tsx scripts/validate-sdk-contracts.ts
node --import tsx scripts/validate-deployment-set-delta.ts
```

The documentation link check validates relative Markdown links and heading anchors in the maintained documentation.

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

`.githooks/pre-commit` then runs, through `scripts/run-script.mts`, the generated-files guard (`generated:guard`) and the staged impact-routed gate (`check:relevant:staged`), which selects the relevant subset of the architecture guard, tests, technical standards, and documentation linters for the staged diff before each commit. The root-script gates need Node and installed dependencies but no package manager. A change under a workspace package selects the turbo package-test lane, which runs package scripts through pnpm, and a few root scripts (such as `install:check`) call pnpm themselves; without pnpm those gates fail and the commit is refused. `npm run architecture:guard:staged` runs before the heavier test suite so missing PACT/protobuf/CUE/parse/event evidence is caught locally instead of burning CI.

## Technical standards

HoBo technical work is TypeScript-first and contract-first. New JavaScript-family code should use the latest stable TypeScript rather than vanilla JavaScript; integration and persistence boundaries use Protobuf contracts; invariants and dependent constraints live in CUE; parsed/refined derivative object definitions implement "Parse, don't validate"; and all integration boundaries need PACT-style consumer-driven contract coverage. Prefer compile-time, codegen, CUE, conformance, and contract-test feedback before runtime error discovery. The `standards:check` gate enforces the baseline across local hooks and CI by requiring the TypeScript toolchain metadata, preserving canonical Protobuf/CUE/PACT guidance, and blocking new JavaScript implementation files in favor of `.ts` sources.

## Documentation maintenance policy

Keep existing user and operator documentation accurate when the behavior it describes changes. Do not create maintenance-only notes, planning documents, or design documents.

## CI and gates

General hosted GitHub Actions workflows remain disabled. The preserved workflow definitions under [`.github/workflows-disabled/`](./.github/workflows-disabled/) do not run. The sole definition in `.github/workflows/` is the manual HoBo runner acceptance recipe; it has no hosted fallback or automatic trigger. Checks that read a workflow definition, such as `ship:gap-closure`, look in both directories, so moving the definitions between them neither fails nor skips those checks.

Run the verification lanes locally:

- `pnpm run actions:lint` checks that no recognized workflow files exist and that preserved definitions remain valid.
- `pnpm run verify:full` runs the release-quality local validation lane.
- `pnpm run verify:extended` adds coverage, mutation, property, and fuzz testing.


The website is published from **`v*.*.*` release tags** via the `release-pages` job in [`.github/workflows/release-hobo.yml`](./.github/workflows/release-hobo.yml) (Astro build → `gh-pages` branch). Manual fallback commands remain in [`site/README.md`](./site/README.md).

Core checks are intentionally ordinary Node scripts so they run locally, in CI, and inside agent sessions. `docs:coverage` also checks that required GitHub community-health and maintenance docs stay present.

## AI agent workflow

This repo is configured for agent/harness-agnostic helper tooling first, with supported shims for Claude Code, Cursor, Codex, and GitHub Copilot CLI where those clients need their own files. Start with [`AGENTS.md`](./AGENTS.md) before editing. Full setup details, devcontainer bootstrap behavior, progressive per-agent setup, cross-agent sync rules, install commands, and data-egress risks are in [`docs/agent-tooling.md`](./docs/agent-tooling.md).

Important rules for agents and humans:

- Do not treat `src/draft/<kind>/<slug>` as production HoBo code; it is executable design proof material.
- Implement HoBo code through the architecture guardrails in [`AGENTS.md`](./AGENTS.md): PACT, protobuf, CUE, parse-don't-validate types, CQRS, event stores, materialized views, actors, rx-style projections, cached snapshots, and persisted historical read-store snapshots.
- Run `pnpm run architecture:guard` when implementation packages change; CI runs the same changed-package guard before the expensive build and test lanes.
- Keep user and operator documentation aligned with shipped behavior.
- Prefer small, reviewable changes that implement the requested behavior.
- Run the local gates before opening a PR.

## Status summary

- **Product implementation:** **144** package manifests under `packages/` (~400k non-test TypeScript LOC under `packages/*/src`, excluding generated clients). All **42** canonical `hobo` CLI verbs are registered in `@hobo/cli` and composed by `@hobo/hobo` against the local lane. Default IaC is an **in-memory Pulumi stand-in** (not live cloud apply); see `HONEST SCOPE` in `packages/hobo/src/compose.ts`. Live-cloud lanes are credential- or engine-gated (`VERCEL_TOKEN`, Cloudflare tokens, `HOBO_PULUMI_LIVE=1`).
- **Pre-release / distribution:** `@hobo/*` packages are **not published to npm** (workspace `0.0.1`). Prefer installing from this monorepo until a publish allowlist and CI-proven release path land.
- **Componentize honesty:** `@hobo/componentize` has two lanes — the offline default builds **synthetic wasm contract bytes** (`buildWasmContractBytes`), and `HOBO_COMPONENTIZE_REAL=1` drives the **real jco/`componentize-js` pipeline** (toolchain-gated, fail-closed, real component-model binaries validated for wasm magic + component layer).
- **Migration & upgrade engine:** live executors ship in `@hobo/trails` (upgrade preflight evidence, expand→backfill→contract over a real SQLite store, pooled→siloed zero-loss tenant move, CDC data-dual ports) with the `migration.*` event family pinned in `@hobo/events`' append-only golden-replay corpus + upcaster-totality gate.
- **Budget-driven routing:** `@hobo/dispatcher` (ADR-0071 deterministic credit/budget selection) + `@hobo/broker` budget signals + the `@hobo/stations` closed routing control loop and progressive cutover saga; rehearse the zero-downtime swap with `pnpm run staging:cutover` (loopback lane available; Vercel/Cloudflare lanes require credentials).
- **Executable proof material:** `src/draft/<kind>/<slug>` packages and repo validation scripts.
- **Primary command surface:** product `hobo` binary from [`packages/hobo/`](./packages/hobo/) (`@hobo/hobo`); shell/factories in [`packages/cli/`](./packages/cli/) (`@hobo/cli`). The same verb surface is served over MCP stdio by the `hobo-mcp` binary (`@hobo/hobo`), with verb/tool parity enforced by contract test.
- **Behavior suite:** epic proofs carry executable Gherkin — `pnpm run test:behavior` runs the offline cucumber lane (feature files under `src/draft/`, plus shipped core acceptance). Live Cloudflare provisioning is explicit: `pnpm run test:behavior -- --profile live-cloudflare`; it requires the local site, Playwright Chromium, network access and authorization to provision a public temporary worker.

## License

See [`LICENSE`](./LICENSE).
