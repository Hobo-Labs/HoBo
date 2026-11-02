# Agent tooling for this repo

This repo is wired for **Claude Code**, **Cursor**, and **Codex** (plus **GitHub Copilot CLI** for Superpowers) with the installable agent tools listed in the [`docs/agent-tooling.md`](docs/agent-tooling.md) table plus repo-local `repo`, `draft`, `sdlc`, and `optimizexp` skills. Full reference + risks: [`docs/agent-tooling.md`](docs/agent-tooling.md). Auth/keys summary: [`AUTH.md`](AUTH.md). One-time binary install: [`scripts/setup-agent-tools.sh`](scripts/setup-agent-tools.sh). `pnpm run doctor` also checks agent-tooling (AUTH, MCP configs, setup `--help`, fail-closed launchers, optional PATH tools). In devcontainers, start with the common layer before agent-specific shims.

| Tool | Type | What it does | Invoke |
|---|---|---|---|
| **sdlc** (repo-local) | skill | Full-loop coordinator: brainstorm → plan → issues → subagents (incremental checkins) → **GitHub stacked PRs** (`gh stack`) → bottom-up rubber-duck/adversarial review → fix comments/checks → squash-merge each PR. **`--finish`** lands the session (commit, rebase, PR, squash-merge all session PRs). Mirrored for all agents. | `sdlc`, `/sdlc --finish`, stacked multi-phase work |
| **gh-stack** (repo-local) | skill + CLI ext | Non-interactive rules for official `github/gh-stack` (`gh extension install github/gh-stack`). | `gh stack init\|add\|submit\|sync\|merge` |
| **improve** (`shadcn/improve`) | skill (read-only) | Audits the codebase and writes prioritized implementation **plans** to `docs/plans/` for other agents to execute. Never edits source. | `/improve`, `/improve quick`, `/improve security`, `/improve execute <plan>` |
| **superpowers** (`obra/Superpowers`) | plugin (skills library) | A development **methodology**: structured **brainstorming**, plan-writing, TDD, systematic debugging, subagent-driven dev, and code-review workflows. No keys. | `brainstorming`, `writing-plans`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, … (14 skills) |
| **impeccable** (`pbakaus/impeccable`) | skill (design) | A **design language** for AI harnesses: 23 commands from `shape`/`critique`/`audit`/`polish` to dials like `bolder`/`quieter`/`colorize`. **Always-on for UI/TUI/dashboard work** — do not wait for the user to invoke it (see **Design system + lint** below). No keys, but not offline: a daily update check to `impeccable.style` from `scripts/context.mjs` run as a command — the hook does **not** fetch (disabled here by `IMPECCABLE_NO_UPDATE_CHECK=1` in `.claude/settings.json`). `/impeccable init` writes `PRODUCT.md` only — `site/DESIGN.md` stays the design authority (ADR-0149). | automatic on visual surfaces; `impeccable critique` / `audit` / `polish` |
| **Higgsfield MCP** (`mcp.higgsfield.ai`) | MCP (hosted, official) | Image/video generation across 30+ models. Account **OAuth**, no API key stored in-repo; project-scoped so it needs human approval before use. Sends prompts to Higgsfield. | `mcp__higgsfield__*` |
| **mattpocock/skills** (`mattpocock/skills`) | skills collection | Engineering disciplines: **`grill-with-docs`** (relentless design interview that writes ADRs + glossary), `domain-modeling`, `codebase-design`, `diagnosing-bugs`, `tdd`, `to-prd`, `to-issues`, `prototype`, … No keys. | `/grill-with-docs`, `/ask-matt`, `/domain-modeling`, `/setup-matt-pocock-skills` (one-time config) |
| **caveman** (`JuliusBrussee/caveman`) | skill + rules | Compresses **agent output** (~65–87% fewer tokens) while keeping technical accuracy. | active by default (see below); `/caveman [lite\|full\|ultra\|wenyan]`, `/caveman-commit`, `/caveman-review`, `/caveman-stats` |
| **ponytail** (`DietrichGebert/ponytail`) | skill | Pushes the **minimalist solution** — YAGNI, stdlib/native before dependencies, one line before fifty; reviews/audits for over-engineering. No keys. | `/ponytail [lite\|full\|ultra]`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain`, `/ponytail-help` |
| **tgrep** (`microsoft/tgrep`) | CLI | Fast trigram-indexed exact/regex search for repo discovery before tests or semantic search. Local, no keys. | `pnpm run search <pattern>` |
| **ast-grep** (`ast-grep/ast-grep`) | CLI | AST structural search/rewrite for code-shape queries; repo-pinned through `@ast-grep/cli` plus `sgconfig.yml`. Local, no keys. | `pnpm run search:structure`, `pnpm exec ast-grep run -p <pattern> -l ts` |
| **Serena** (`oraios/serena`) | MCP server | IDE-like semantic code retrieval, symbol-aware editing/refactoring, and project memory through LSPs. Local-first, no keys. Fail-closed launcher when binary missing. | MCP tools after `serena init`; shared launcher `scripts/agent-mcp-serena.sh` |
| **headroom** (`chopratejas/headroom`) | MCP server | Compresses **context fed to the model** (tool outputs, logs, files); reversible via `headroom_retrieve`. Local-first, no keys. Fail-closed launcher `scripts/agent-mcp-headroom.sh`. | MCP tools `mcp__headroom__*`; optional proxy `headroom proxy` |
| **RTK** (`rtk-ai/rtk`) | CLI proxy/hooks | Rust Token Killer compresses noisy shell-command output before agents see it. Local, no keys. | installed by `scripts/setup-agent-tools.sh`; `rtk <cmd>`, `rtk gain` |
| **gbrain** (`garrytan/gbrain`) | MCP server | Knowledge-graph **memory**: capture notes, hybrid search + synthesis. Fail-closed launcher `scripts/agent-mcp-gbrain.sh` (AUTH.md remediation when binary/key missing). | MCP tools after `gbrain init` + embedding key; CLI `gbrain capture/search/query` |
| **SkillOpt** (`microsoft/SkillOpt`) | optimizer / research harness | Trains reusable markdown skills from scored rollouts and exports `best_skill.md` artifacts for multiple harnesses. Optional, not runtime config. | `skillopt-train`; `scripts/skillopt-sleep.sh status|dry-run|run|adopt`; installed from microsoft/SkillOpt |
| **anti-slop** (`dmmulroy/anti-slop`) | vendored Oxlint plugin + skill | Opinionated lint rules rejecting low-evidence/low-signal TS patterns (chained assertions, `unknown` contracts, ad hoc `typeof`, module mocking, unjustified casts). Vendored at `tools/oxlint/anti-slop/`, configured in `oxlint.config.ts`. Local, no keys. Pre-commit / `agent:check` run `lint:slop:changed` on touched TS/JS (`--deny-warnings`); full-repo `lint:slop` is opt-in because of a large pre-existing backlog. Each copy (tools + both skill assets) carries `MANIFEST.sha256`; `scripts/test/anti-slop-vendor.test.ts` is the drift gate (ADR-0173). | `pnpm run lint:slop:changed`; `pnpm run lint:slop`; reinstall/refresh via the `install-anti-slop` skill (all agents) |

How they fit together: **Serena** gives agents semantic code tools, **superpowers** + **mattpocock/skills** supply the *workflow & rigor* (brainstorm → grill-with-docs → plan → build/TDD → review), **improve** decides *what* to do, **ponytail** keeps the code itself minimal (YAGNI / stdlib-first), **impeccable** + `pnpm run design:lint` are the standing visual quality loop (not opt-in), **headroom** + **RTK** + **caveman** keep token use down (context-in, shell-output, and agent-output — complementary), **gbrain** remembers across sessions, and **SkillOpt** is reserved for offline improvement of reusable skills when we have scored tasks.

## Repo-local repo skill

The repo-local **repo** skill lives in both `.agents/skills/repo` and `.claude/skills/repo`. Use it for repository lifecycle work: setup, cleanup, search, scoped implementation, validation, commits, PR handoff, deployment, and iteration. It encodes the performance-first loop:

```text
Search before validate.
Validate changed scope before package scope.
Validate package scope before repo scope.
Use fast approximate tools first.
Use exact/slow compatibility tools last.
```

The skill defaults to local hybrid retrieval: OKF `index.md` files, `tgrep` when available, `rg`, `fd`, `ast-grep`, `git grep`, and memory/semantic tools only after exact or structural search narrows the question. It does not use Google ingestion or querying products by default. It also repeats core repo rules: preserve user work, use `git mv` for tracked moves, avoid broad install/codegen/test commands as diagnostics, rebase on `origin/main`, run the narrowest relevant `agent:check` scope, and open or update an auto-merge squash PR only after checks and comments are clean. No-arg `agent:check` validates the latest commit against `HEAD~1`; use `agent:check -- --staged` before committing staged fixes and `agent:check -- --base=origin/main` only when intentionally validating the whole PR branch. `agent:check` must stay impact-scoped: direct draft workspace tests use `pnpm --prefix <workspace> test`, broad root unit/contract sweeps are explicit final/all validation, and concurrent checks are bounded by `HOBO_RELEVANT_CHECK_CONCURRENCY`.

## Repo-local sdlc skill + implementer/reviewer subagents

The repo-local **sdlc** skill (mirrored in `.agents/skills/sdlc` and `.claude/skills/sdlc` — Claude Code, Cursor, Codex, Grok, and any agent that loads those trees) coordinates full-loop feature development: brainstorm → adversarial/rubber-duck hardening → plan mode over the draft-proof cascade (technical → epic; experience proofs in parallel; projects aggregate) → Linear capture as one-shot issues (verifiable outputs + required draft artifacts named per issue) → **permission-gated** dispatch through a harness-detected backend matrix (see `references/dispatch.md`): cloud coding agents (GitHub coding agent via MCP/`gh agent-task`, Codex cloud, Cursor background) are preferred for isolated one-shot issues; local subagent worktrees handle shared-file-adjacent work; a sequential fallback keeps the loop alive when no delegation capability probes true. **Leverage subagents as much as possible**; implementers **commit incrementally** (red→green→commit, not one dump at the end). For multi-step/phase/task work the **parent** opens a **GitHub stacked PR** with the official `gh stack` extension (`github/gh-stack`, also documented in the companion **`gh-stack`** skill). Every backend receives the same one-shot issue contract and returns the same handback schema — `.sdlc/report.json` in a worktree, or a fenced `sdlc-report` JSON block in the PR body for cloud dispatches. The Claude Code backend is two subagent definitions under `.claude/agents/`:

- **implementer** — one Linear issue, one isolated worktree, strict red/green TDD/BDD/ATDD (the acceptance checklist becomes the failing tests: unit, PACT contract, cucumber feature, bench), **incremental checkins**. Zero Linear access; never edits shared files; hands back `.sdlc/report.json` with gates, cascade deltas, and requirement discoveries.
- **reviewer** — read-only; independently re-runs the gates and walks the acceptance checklist (cloud PRs get the same walk against a local checkout of the PR branch).

The coordinator owns ALL Linear state, shared-file mutations, and **stack topology** (single-writer). When implementation is done, the parent **must close every opened PR from the bottom up**: rubber-duck + adversarial review of each layer, address all PR comments and review feedback, fix required status checks that actually ran, then **squash-merge** that PR (`gh stack merge <pr> --yes --squash` or `gh pr merge --squash`) and sync before moving up the stack. **Billing/spending-limit/quota CI failures do not block squash-merge** — document them on the PR and merge anyway (use `--admin` if protection requires green checks). An issue is Done only when checks are green **or only billing-red**, independent review passes, comments are resolved, and the PR is squash-merged — never on an implementation agent's self-report. Durable loop state lives in `docs/plans/<initiative>/sdlc-state.md`; dispatch outcomes feed `docs/plans/dispatch-log.md`, which the next Linear-planning pass consults to improve issue contracts.

**Stacked PRs install:** `gh extension install github/gh-stack` (also via `scripts/setup-agent-tools.sh` common layer). Local git defaults `rerere.enabled=true` and `remote.pushDefault=origin` are applied by `scripts/install-hooks.mts` / the setup script.

## Repo-local draft skill

The repo-local **draft** skill lives in both `.agents/skills/draft` and `.claude/skills/draft`. Use it when creating, moving, or reviewing draft proof material. It replaces the old one-level draft convention with the four-layer taxonomy:

- `src/draft/technical-proofs/<slug>` for isolated atomic technical concepts.
- `src/draft/exp-proofs/<type>/<slug>` for experience proofs, grouped by experience type (`dx` developer · `ux` user · `cx` customer · `ax` agent · `api` API/SDK surface) per [`src/draft/exp-proofs/_classification.md`](src/draft/exp-proofs/_classification.md).
- `src/draft/epic-proofs/<slug>` for isolated epic rollups that reuse technical and experience proofs.
- `src/draft/projects/<slug>` for project MVP rollups that integrate epic proofs.

Repo-local skills keep Codex-valid `SKILL.md` frontmatter and store Open Knowledge Format concept metadata in their `references/` bundles. `pnpm.cmd run docs:okf` validates the docs OKF bundle plus the `repo`, `draft`, `sdlc`, and `optimizexp` skill reference bundles in both agent mirrors. `pnpm run skills:mirror-check` asserts the `.claude`/`.agents` skill mirrors stay byte-identical (runs automatically via `agent:check` when skill files change).

## Repo-local optimizexp skill

The repo-local **optimizexp** skill (mirrored in `.agents/skills/optimizexp` and `.claude/skills/optimizexp`) optimizes **experiences** — UX, DX, and AX — using repo personas under [`.optimizexp/personas/`](.optimizexp/personas/), persona Gherkin **feature folders** under [`.optimizexp/features/`](.optimizexp/features/), **evidence** capture via `harness/capture-evidence.mts`, a write-ahead agent bus under [`.optimizexp/bus/`](.optimizexp/bus/), and iterative **measure → reduce experiment → verify** cycles that lower **harms**, **friction**, and **uncertainty** until **true** plateau (scores flat **and** no implementable S/M findings left; **no iterations flag / pass budget**; **`--report-only`** to measure without edits). Derived fixes must be **implemented in-run**, not parked as residual. PR delivery uses incremental commits and posts evidence (`harness/post-pr-evidence.mts`). Host workflows live under the skill's `workflows/` tree. See [`.optimizexp/README.md`](.optimizexp/README.md).

### Draft-proof hardening

Every proof layer has **folder-scoped `AGENTS.md` instructions** beside the packages (`src/draft/<kind>/AGENTS.md`, plus one per exp type folder) and scaffolding templates under `src/draft/_templates/<layer>/`. New/changed proofs are validated by two gates that run automatically through `agent:check`:

- `pnpm run draft:artifacts` — per-layer artifact requirements from a `proof.json` manifest (`scripts/lib/proof-manifest.ts`): gate-**executed** `examples/`, executed tslab `notebook.ipynb`, bench for technical proofs, executable cucumber `features/` for epics (`pnpm run test:behavior`), per-type experience artifacts for exp proofs. Waivers need an ADR.
- `pnpm run draft:cascade` — a changed technical/exp proof must update every referencing epic/project rollup in the same diff (references resolve from `proof.json` graphs + import/ledger scans).

Packages predating the standard are listed in `src/draft/_grandfathered.json` (advisory-only until their backfill wave removes them; never add new packages there).


## Parallel work rule

Only edit files directly related to the assigned task.

Prefer changes inside one package, app, feature folder, or test folder.

### Connectivity, naming, multi-tenant foundations

- Hierarchical DNS-valid names are pure functions in `@hobo/core` (`getNamedEndpoint`, `sanitizeDnsLabel`). Never emit bare `.hobo`; use `.hobo.localhost` (local) or `.hobo.test` (overlay). See [ADR-0130](docs/design/adr/07-portability-extensibility.md#adr-0130).
- Implementations for overlay (Tailscale/Netbird), pluggable DNS, tag/ACL `PolicyEngine`, metering sinks, and optional portless local named endpoints live in `@hobo/connectivity`.
- Local serve paths inject `namedEndpoints` / `primaryNamedUrl` when available; port-based behavior remains the default offline path when portless is absent (`HOBO_PORTLESS=0` forces off).
- Tenant context: `HOBO_TENANT` / `HOBO_PROJECT` / `HOBO_BRANCH` / `HOBO_ENV`. Soft multi-tenancy via IDs + PolicyEngine is the baseline; hard isolation is a later phase.

### Station occupancy (ADR-0131)

- **Station** is the hard control-plane isolation boundary a Conductor occupies — **not** app-topology containment (Bindle ⊂ Camp ⊂ Yard ⊂ Junction unchanged).
- Package `@hobo/stations`: `station()`, StationService, Rails (content-addressed), bootstrap Rail, local Station client under `HOBO_HOME/stations/`.
- Station owns Connections + Rails; Broker is pure Conductor (receipts pin `stationId` + `railHash`). Cross-Station Connection use fails closed without federation grant.
- Stations also host the **traffic-routing plane** (ADR-0143): the per-resource-class **offering registry**, the **closed routing control loop** (budget/health signal → re-dispatch → re-synthesize → re-apply, with StabilityPolicy cooldown/hysteresis/flip limit), and the **progressive cutover saga** (fail-closed preconditions, rollback hysteresis, refusal + `TtlLowered` ladder). The picker is `@hobo/dispatcher` (ADR-0071, deterministic credit/budget selection; `dispatch.Decided`/`dispatch.Reservation*`); budget signals (`budget.ThresholdCrossed`/`Recovered`, exactly-once) come from `@hobo/broker`.
- CLI: `hobo station init|up|down|status|rails *` is **ops/setup**, not a lifecycle verb. Missing Station fails closed (`hobo station init`).
- Profile: `defaultStation` / `activeRail` required for control-plane work; `defaultBrokerUri` is only a remote Conductor HTTP endpoint, not a setup path.
- **Station capabilities + localhost discovery (ADR-0155):** `StationCapability` (`hobo.station-capability/v1`, closed kind vocabulary, provenance `default|discovered|declared`) formalizes the "PAM/Replay/sidecars are Station capabilities" prose; matching against host evidence is fail-closed and persists `HOBO_HOME/stations/<id>/capabilities.json`. `hobo-code init` is the discovery-gated dev seed (probes Node/git/isolation matrix/ollama/devenv/harnesses; required-missing refuses to write). hobo-code dev scenarios dogfood `station()` declarations (`codeDevStation` in `packages/code/src/dev-stations.ts`) — never re-introduce ad-hoc init literals. Narrative: `docs/design/stations.md`.

### Portable SQLite EventStore / durable actor journal (ADR-0135)

- SQLite is the **default durable engine** behind HoBo-owned ports — **not** the public portability boundary. Managed stores remain adapters.
- Package map: `@hobo/core` (`EventStore` / `DurableEventStore`, positions, fences, errors) · `@hobo/storage-sqlite` (schema v2, migrations, `SqliteJournal`, codecs) · `@hobo/runtime-local` (Node `node:sqlite` + storage worker) · `@hobo/runtime-browser` (WASM/OPFS policy; fail-closed without real OPFS) · WIT `hobo:storage@0.1.0`.
- **One SQLite partition, one active writer.** Scale by partitions; never multi-writer WAL over shared NFS/SMB.
- Stream revision via **stream-head row** (not `COUNT(*)`); append CAS + `fenceToken`/`owner_epoch` inside one write transaction; database-local `global_position` for catch-up (not domain envelope identity).
- Durable commit can stage queue / actor-signal / timer / cron / outbox effects atomically with domain events; network I/O stays **outside** the SQLite transaction.
- Delivery: per-stream OCC, fenced single writer, at-least-once subscriptions/outbox, idempotent keys — **not** external exactly-once.
- Design: [`docs/design/adr/03-data-plane-sqlite-default.md`](docs/design/adr/03-data-plane-sqlite-default.md), package-namespaces, `docs/design/data-plane.md`.

### Contract effects + visible resiliency (ADR-0136)

- Optional `effects?: EffectSpec` and `resilience?: ResilienceProfile` on `BoundaryContract` in `@hobo/contracts` (protobuf + CUE + parse-don't-validate TS).
- **EffectSpec** (Verse-inspired): purity lattice `pure` ⊂ `varies` ⊂ `transacts` ⊂ `noRollback`; capabilities (`decides`, `suspends`, …); domain I/O (`network`, `storage`, …). Effect **widening** is a breaking compatibility reason (`effect-widened`) when effects are declared.
- **ResilienceProfile** is a **secondary** visible layer (retry / circuitBreaker / timeout / bulkhead / fallback / hedging). Thin `applyResilienceProfile` applicator emits facts; **never** retries `policy.Decided` deny, terminal, or cancellation — aligned with [`docs/design/dx-sdk-resilience-semantics.md`](docs/design/dx-sdk-resilience-semantics.md). Not a primary control-plane noun.
- Capture/export: `EffectManifest`, `EffectTracer` (`contract.EffectDeclared` / `contract.EffectInvoked`); Gatekeeper `effectSummaries` + `gate: "effects" | "resilience"`.
- Harness: `@hobo/contracts` `createEffectIsolation`, `mocksForEffects`, `runResilienceFaultInjection` — pure contracts isolate with zero infra (`@hobo/contract-harness` itself stays dependency-free PACT infra).
- No public Effect-TS, Polly, or XState dependency. Design: [`docs/design/adr/03-data-plane-effects-resiliency.md`](docs/design/adr/03-data-plane-effects-resiliency.md).

### Secretless-first config & secrets (ADR-0027)

- Prefer identity federation / `fromBinding` / ranked `bound-resource` over any stored secret. `hobo:secrets` and catalog `secret(name)` are **residual** Nitric-parity only ([ADR-0113](docs/design/adr/02-identity-security.md#adr-0113)).
- Authoring: `@hobo/bindles` `config({ ... })` with `env.string()` / `secret.string().source(...)` / `secretRef` / `fromBinding`. Dual surfaces: `env({...})` annotations + `env.string()` fields; `secret(name)` resource + `secret.string()` fields. Codegen: `generateCtxConfigSource`. Gate: `evaluateSecretlessConfigGate` (wired into Gatekeeper via `secretlessConfig`).
- Resolution: `@hobo/identity` `resolveConfigSchema` ladder (`bound-resource` → `provider-federation` → `camp-value` → `static-escape` ≤7d). Camp adapters via `createCampSecretsPort` (Vault JWT/OIDC, AWS SM, Azure KV with brokered fetch). Events `config.Resolved` / `secret.Accessed` are refs-only (never-compact CredentialAudit). Conformance: `requireNoPlaintextConformance`. Local non-sensitive overrides: `encryptLocalOverrides` / `decryptLocalOverrides`.
- Continuous Identity Migration ([ADR-0132](docs/design/adr/02-identity-security.md#adr-0132)): dual-path PrincipalRef continuity is Matching/policy-driven with **zero required Bindle config**; dual fixtures extend ADR-0070 offline; observe via `hobo identity status` / `hobo doctor`; never invent a parallel IdP or Bindle migration DSL.
- HoBo Trails ([ADR-0134](docs/design/adr/02-identity-security.md#adr-0134), `@hobo/trails`): app-owned continuous migration recipes (schema/data dual, junction rebind, cutover) that **compose** continuous identity as `identity.continuous`. Pure identity continuous still requires **zero Trail authoring**. Observe via `hobo trails status|plan|inspect`; progressive via existing Harness; do not invent parallel progressive/ETL planes.
- **Live migration executors** (`@hobo/trails`, [upgrade-migration-engine](docs/design/upgrade-migration-engine.md)): upgrade preflight/compatibility evidence (`upgrade-preflight.ts`, fail-closed scope-boundary guard), expand→backfill→contract over a real SQLite store (`migration-executor.ts`, snapshot-before-mutation, compat-gated destructive contract), pooled→siloed zero-loss tenant move (`tenant-move-port.ts`: fence → drain → export/import → checksum-gated reap), live CDC data-dual ports. Emit the `migration.*` event family only.
- **Event-body evolution gate** (`@hobo/events`): bumping any pinned event body (e.g. `migration.*`) **requires** a total upcaster plus an append-only entry in `packages/events/corpus/golden-replay-baseline.json`; corpus coverage/purity/append-only violations fail the test lane and with it can-deploy. Never edit or delete pinned corpus entries.
- **Jurisdiction & residency** ([ADR-0146](docs/design/adr/02-identity-security.md#adr-0146)): legal geography is typed in `@hobo/core` (`ports/jurisdiction.ts`) — `evaluateResidency` is pure and **fail-closed** (unmapped region = conflict); tenants carry `residency` constraints; Gatekeeper reports a `residency` gate. Compliance rules ride `@hobo/policy` (residency pack, control→evidence packs). Never bypass with untyped region strings.
- Residual classical credentials: `@hobo/connectivity` secretless connector plugins (postgres/tcp/mysql/redis + registry); isolation tiers; workload dials named endpoints only — never receives material.
- WIT: `hobo:secrets@0.1.0` under `@hobo/wit` (experimental); bridge with `asHoboSecretsStore`.
- Agents / `hobo dev`: schemaOnlyView + contract-asserted fixtures; no plaintext in agent context, events, or IaC.
Avoid shared/global files unless the task explicitly requires them:

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `turbo.json`
- root `tsconfig*.json`
- `.github/workflows/**`
- `AGENTS.md`
- generated files
- shared fixtures
- central registry/barrel files

Do not hand-edit generated files. Avoid manual barrel-file edits; prefer direct imports or generated barrels. Split shared fixtures into scenario/domain-local files when a task needs fixture changes. Change `package.json` or lockfiles only for dependency-related tasks.

The generated-files pre-commit guard (`scripts/no-hand-edited-generated-files.mts`) accepts generated-output changes only when the same commit also touches their driving sources: protobuf/CUE schemas, WIT interfaces, or a recognized generator (schema-tools, `packages/wit` codegen + `wit-lock.json`). Regenerate with the owning codegen command (`pnpm run codegen`, `pnpm --filter @hobo/wit run wit:gen`) rather than editing outputs.

## Generated-art rules (Spriterrific, Higgsfield, any image/video model)

**Skill precedence: the local `spriterrific` CLI skill beats `spriterrific-api`.**
Same engine; the local one writes a reviewable run folder and catches a bad
anchor before it is animated, which is where the cost is. Use the hosted API
only when the CLI genuinely cannot run (no `FAL_KEY`, no Python, no tool) or the
user asks for it — and say which you used.

### Where assets land

Three tiers, and the boundary between them is *review*, not convenience:

| Tier | Path | Committed | What it is |
|---|---|---|---|
| Run | `media/runs/<run-id>/` | **no** (`.gitignore: runs/`) | raw generator output, prompts, provider payloads. Reproducible; large. |
| Reference | `media/public/reference/` | yes | reviewed art you generate *from* — turnarounds, model sheets, meshes. Never served by the site. |
| Shipped | `site/public/parallax/` | yes | what the live site loads. Normalised to the sheet contract. |

Promote **upward only, and only after review.** Never commit a run folder, and
never let generator output reach `site/` without passing the character lock in
`site/public/parallax/README.md`. The repo already carries one folder of
off-model sheets (`site/public/bo-actions/`, 1.28 MB, unreferenced) from
skipping that step; do not add a second.

### Visualise before promoting — and look at it

Generated art fails in ways gates cannot see. A checklist that passes CI and an
image with a mouth on a mouthless character are the same thing to `agent:check`.

- **Render it and actually look**, at the size it will ship. Read the file back;
  do not infer from the prompt you sent.
- **Play sequences, don't eyeball sheets.** A spritesheet flat tells you nothing
  about timing. `media/` renders every sheet animated from its real frame
  geometry — add new sheets to `media/src/data/assets.ts` and view them there.
- **Compare against the reference numerically**, not by vibe: silhouette
  overlap, grey/alpha level histograms, opaque-pixel counts, feet baseline. The
  measurable checks are what caught legs shipping at grey 41–82 against the
  reference's 0.
- **Composite in context** — a plate looks fine alone and wrong over the band.

### Reporting back

Every reply that produces or changes an asset ends with **somewhere the user can
look**, not a path they have to go find:

- a **live URL** when it is deployed — the catalogue is
  `https://tyler-r-kendrick.github.io/HoBo/media/`, the site is `/HoBo/`;
- the **local page** otherwise (`pnpm --filter hobo-media run dev`), plus the
  repo path;
- for Spriterrific specifically, the run's own `review/index.md`.

State plainly what is **promoted** versus what is **sitting in a run for
review**, and if the output is off-model, say so and leave it in the run. An
asset the user cannot see is not delivered.

## Draft-proof promotion policy

When a draft proof under `src/draft/` is promoted into a production package, **the package copy becomes canonical and the proof is frozen** — record the promotion in [`scripts/promotions.json`](scripts/promotions.json) (`status: "frozen"`, digests pinned via `pnpm run promotions:check -- --update`). After that, all changes land in the package; `pnpm run promotions:check` (enforced by the root test suite) fails if a frozen proof is edited. Partial promotions that deliberately leave capability behind in the proof use `status: "reference"` with a note explaining the split. This exists because promoted copies previously diverged silently (see GAPS.md implementation-gap register, IMPL-005/IMPL-006).

Before finishing a whole PR branch:

```bash
git fetch origin
git rebase origin/main
pnpm agent:check -- --base=origin/main
```

If there are conflicts, resolve them before finalizing.

## Technical standards for code and contracts

These rules are harness-neutral and apply to Claude Code, Cursor, Codex, Copilot CLI, and any other agent editing this repo:

- Prefer compile-time feedback over runtime error discovery. Treat typecheck, generated-contract, CUE, conformance, and PACT failures as design feedback, not cleanup.
- Use the latest stable TypeScript toolchain for new JavaScript-family implementation, executable contract, and proof code. Do not add new vanilla JavaScript modules when TypeScript can provide static feedback; migrate touched legacy JS opportunistically.
- Use Protobuf for data contracts at integration and persistence boundaries. Keep WIT, Protobuf, TypeScript, runtime guard, and documentation views generated from one source family or explicitly reconciled in proof fixtures.
- Use CUE for invariants and dependent constraints: ranges, formats, cross-field relationships, state transitions, capability predicates, policy obligations, and compatibility rules.
- Implement "Parse, don't validate": untrusted input crosses one parser boundary and becomes a refined/derivative object definition. Core functions should accept parsed/refined domain types, not raw DTOs plus repeated boolean checks.
- Require PACT-style consumer-driven contract tests for every integration boundary: SDK/runtime, runtime/provider, CLI/API, event/projection, generated plugin/host, and external service edges.
- When changing code, automation, package metadata, CI, hooks, or agent tooling, update docs/proof notes to identify the TypeScript, Protobuf, CUE, and PACT gates that protect the change, or document the tracked gap.

Canonical detail lives in [`docs/design/technical-standards.md`](docs/design/technical-standards.md).

## Design system + lint (always-on)

Visual work is a first-class gate, same as typecheck and PACT. **Do not wait for the user to say “run design lint” or “use /impeccable.”** If you touch a visual surface, apply the design system while editing and run the linters before you claim the work is done.

A change is visual when it touches any of: `site/`, `packages/code` TUI/dashboard/Evidence HTML, `packages/control-yard`, a package `DESIGN.md`, CSS/HTML chrome, `tui-*.ts(x)`, `interactive-shell.ts`, `session-dashboard.ts`, `evidence-chrome.ts`, or rendered copy/color/layout/motion.

### Authority

| Surface | Binding DESIGN.md | Implementation |
|---|---|---|
| Public site | [`site/DESIGN.md`](site/DESIGN.md) | `site/src/styles/` |
| `hobo-code` TUI + occupancy dashboard + Evidence | [`packages/code/DESIGN.md`](packages/code/DESIGN.md) | `tui-tokens.ts`, `tui-components.tsx`, `evidence-chrome.ts` |
| Control-yard | [`packages/control-yard/DESIGN.md`](packages/control-yard/DESIGN.md) | that package only |

`site/DESIGN.md` is the product identity (ADR-0149). Do not run `/impeccable document` at the repo root. Do not invent a fourth identity.

### While editing

1. Read the owning `DESIGN.md` **before** the first visual edit.
2. Use the package design system: `TUI_TOKENS` / `DESIGN_COLOR_TOKENS`, Evidence chrome helpers, and React-style TUI components (`ShellChrome`, `BroadcastFrame`, `InkTable`, `WelcomeSurface`, `AgentPanes`, `TextPane`, …). Do not hand-roll hex, SaaS blues, extra accents, or ANSI color outside `rubberhose.ts` `ACCENT`.
3. New TUI chrome is a component in `tui-components.tsx` (or a sibling `tui-*.tsx`), then composed. Do not assemble the main screen from raw `h()` strings or `TextPane` dumps when a component exists.
4. Spark (`#c5301c`) and go (`#14672c`) stay rare. Never paint a whole frame, hover-every-control, or night-collapse cards into the ground.
5. After visual edits, run impeccable `critique` then `audit` (and `polish` if they find P0/P1) on the files you changed. That is part of the implementation loop, not a later favor.

### Before you say done

```bash
pnpm run design:lint
```

Plus the package lints that actually cover the files you touched:

- `@hobo/code` TUI: `packages/code/test/tui-design-lint.test.ts` (includes `interactive-shell.ts`)
- Evidence + dashboard HTML: `packages/code/test/evidence-design-lint.test.ts`
- Visual fixtures: `packages/code/test/tui-visual.test.ts` / `lookfeel.test.ts` when chrome geometry changed

`pnpm agent:check -- --staged` already selects `design:lint` when UI/`DESIGN.md` files change. That is not a reason to skip the explicit lint or to skip impeccable on a visual diff. A change that fails `design:lint` or the package design-lint tests is not complete.

## Lint budget (ratchet)

The repo carries a standing biome backlog — the kind that accumulates when the
lint gate is package-scoped and nobody looks at the whole tree. It is bounded by
a ratchet rather than cleared in one sweep, because a sweep of that size buries
every reviewable diff and several findings need reading one at a time.

```bash
pnpm run lint:budget            # fails when findings rise above the recorded budget
pnpm run lint:budget -- --update # lowers the budget after you fix some
```

`scripts/biome-budget.json` holds the counts. `--update` **lowers** the budget
and refuses to raise it — a ratchet you can loosen with a flag is not a ratchet.
So new code cannot add findings, and the backlog is paid down opportunistically
by whoever is already in the file.

Do not mass-apply `--unsafe` fixes for `lint/style/noNonNullAssertion`. Biome
rewrites `x!.y` to `x?.y`, which turns a throw into an `undefined` — a silent
behaviour change. Read each one: two found that way (in DPoP's `htu` check and
the bindles regex parser) were concealing real invariant gaps, not documenting
them.

## Building before a repo-wide test run

`pnpm run build` covers `./packages/**` — every nested package, not just direct
children of `packages/`. `pnpm run test` builds first via `pretest:unit` (~14s
warm) because the repo-wide vitest sweep imports built dists from workspace
packages, and without it a suite fails on whichever package happened to be
stale rather than on anything real.

### One build graph, not two

Turbo owns the build graph. `tasks.build.dependsOn` is `["^build"]`, so a
package's workspace dependencies are already built — and cached — before its
own build runs, and `tasks.test.dependsOn` is `["build"]`, so a package's own
dist is there before its tests run.

Never build another workspace package from a package script. 47 packages used
to carry `"prebuild": "pnpm --filter @hobo/core build"` and 100 carried a
`pretest` that rebuilt themselves and their dependencies; those run *outside*
turbo, so they never hit the cache and a full sweep paid roughly 150 cold `tsc`
invocations underneath the cached graph it had just finished. `pnpm run
standards:check` fails the tree if one comes back.

A package that genuinely needs its own dist before tests — because someone runs
`pnpm --filter <pkg> test` directly, outside turbo — uses the shim:

```json
"pretest": "node --experimental-strip-types ../../scripts/ensure-built.mts"
```

`scripts/ensure-built.mts` exits immediately when `TURBO_HASH` is set (turbo
injects it into every task process, `envMode: "strict"` included) and otherwise
delegates to `turbo run build --filter=<self>`, so the standalone path is cached
too.

`tasks.build.inputs` excludes `test/**`, `contracts/**`, `**/*.test.ts`, and
`**/*.md`. Every package's build tsconfig compiles `src` only — `@hobo/ci-guard`
is the single exception and carries its own task override — so editing a test
can no longer invalidate 124 builds and everything downstream of them.

Every turbo invocation in this repo passes `--concurrency=100%` — one task per
logical CPU. This is a **memory** limit, not a speed one, and the difference
matters: on a fixed 224-task set, turbo's default of 10 and a cap of 4 finish
within noise of each other (5m49s vs 5m36s on a four-core box), so capping costs
nothing. What it buys is that a fully-cold 902-task sweep at the default OOM-kills
`@hobo/example-self-host-yard` — exit 137, `SIGKILL`, not an assertion — because
each turbo task is a `pnpm` plus a vitest plus its worker pool, and ten of those
do not fit in 16 GB. Percentage rather than a fixed number so the cap scales with
whatever machine it lands on.


Generated output belongs to exactly one generator. `packages/code/src/_generated`
is the protobuf codegen pipeline's; TUI art from `gen-logo-tui.mts` /
`gen-bo-idle-tui.mts` lives in `_generated-art`. Two generators sharing a
directory makes the drift check report the other's output as unexpected.

## JavaScript-family implementation file policy

This repo requires new JavaScript-family implementation files to be TypeScript-family files.

Do not create new implementation files with these extensions:

- `.js`
- `.jsx`
- `.mjs`
- `.cjs`

Use one of these instead:

- `.ts` for normal TypeScript source
- `.tsx` for React/JSX TypeScript source
- `.mts` for TypeScript ESM files that should behave like `.mjs`
- `.cts` only when CommonJS semantics are explicitly required

Prefer `.ts` unless the file needs explicit ESM behavior independent of the nearest `package.json` `"type"` field. For ESM repo scripts that would previously have been written as `.mjs`, use `.mts`.

Examples:

```txt
scripts/no-hand-edited-generated-files.mts
scripts/check-package-boundaries.mts
scripts/install-hooks.mts
```

Invoke TypeScript repo scripts through `tsx`:

```bash
node --import tsx scripts/no-hand-edited-generated-files.mts
```

Do not add `.mjs` repo scripts. If a non-TypeScript JavaScript-family implementation file is unavoidable because of a tooling limitation, document the exception in an ADR before adding it. Sanctioned exceptions: committed platform entry files under `packages/hobo/fixtures/deploy/<provider>/` that the target platform ingests verbatim (ADR-0126).

Before finalizing changes that add, rename, or modify implementation files, scripts, generated-file guards, package config, TypeScript config, Turbo config, or CI config, run:

```bash
pnpm run standards:check -- --base=origin/main
```

If this check fails, fix the violation rather than bypassing it.

## HoBo implementation architecture rules

All HoBo implementation work, including `src/draft/<kind>/<slug>` proof packages, must preserve these architectural contracts:

- **Bindle + abstract ports is the path of least resistance for app authoring.** Declare resources with the provider-neutral bindle kinds (`data`, `bucket`, `queue`, `api`, …) and let Matching select providers; `assertNoBindleProviderSelection` rejects provider pins on Bindles by construction — provider-specific `.with(...)` options belong at Camp/Yard scope and are scored as lock-in by the PortabilityReport (ADR-0024). Before claiming a thin SaaS adapter (Convex-class) covers a capability, check its impedance boundaries (typed limits exported by the provider package + the competitor doc's "Impedance boundaries" section) — never over-claim fidelity (ADR-0144).

- Enforce every service boundary with PACT contracts. A boundary is not implemented until consumer/provider expectations, headers, payloads, and error envelopes are executable.
- Define records, messages, data shapes, and domain objects in protobuf first. Runtime record types must be the **generated** ones: a package opts into codegen by adding `data-models/buf.yaml`, runs `pnpm run codegen` (`@hobo/schema-tools` → buf/protoc-gen-es), and imports its types from the checked-in `src/_generated/**_pb.ts` (reference consumer: `packages/core`). Hand-declaring a TS interface that duplicates a proto message is a violation; derived types must be brands/narrowings **of** the generated types. `pnpm run codegen:check` is the drift gate.
- Attach CUE constraints for every protobuf type and keep them with the protobuf contract or proof package. Do not create a repository-wide `contracts/data-models` catalog; each project/package that defines a CUE-constrained type owns its own local `data-models/` folder.
- **What the CUE gate actually checks, and what it does not.** `pnpm test:schema` runs two separate things. `scripts/check-cue-schemas.ts` is repo-wide: every `.cue` file must parse, resolve its references, and carry no type conflict that no data could satisfy (a list unified with a number, a func, or a struct). It groups files by directory and `package` clause, so a definition in a sibling file of the same package resolves. It deliberately ignores what `cue vet` says about a schema evaluated against *no* data — `invalid value [] (out of bound !=[])`, `some instances are incomplete`, and a hidden-field constraint reporting `conflicting values false and true` are artifacts of vetting a definition with no instance, not defects, and a check that reported them would flag hundreds of healthy files. `vetCueConstraints` in `@hobo/schema-tools` is the stronger check that evaluates constraints against real records — but it only runs for a package whose `data-models/` has both a `buf.yaml` and `fixtures/valid` + `fixtures/invalid` directories, which is 6 of 191 `data-models` directories. **A green `test:schema` therefore means your constraints are well-formed, not that they have ever been tested against a record.** Ship fixtures if you want the latter.
- Parse, don't validate: do not pass broad primitive or DTO values after checking them. Introduce derived parsed types whose constructors apply protobuf and CUE constraints so invalid values are unrepresentable beyond the boundary.
- Build flows on CQRS, event stores, materialized views, and actor models. Actors consume commands, emit events, and coordinate durable state; they do not mutate query read models directly.
- Keep query surfaces event-driven: expose rx-style projections over materialized views, use cached snapshots for current reads, and persist historical snapshots in a read store.
- For new behavior, name the command/event families, replay expectations, projection behavior, snapshot/read-store persistence, and the PACT/protobuf/CUE proof that pins the boundary.

Local and CI gates enforce this early with `pnpm run architecture:guard`. The canonical package layout these rules assume — each package pairing `package.json` and `tsconfig.json` with `src/`, `test/`, `contracts/`, and its own local `data-models/` folder — is additionally enforced structurally by [**konsistent**](https://www.npmjs.com/package/konsistent) (Vercel's structural linter for TypeScript codebases). The root [`konsistent.json`](konsistent.json) declares the `production-package-scaffolding` and `nested-package-scaffolding` conventions; run them with `pnpm run konsistent`. It is pinned as a dev dependency via pnpm, wired into `pnpm run check:all`, and selected by the narrow gate (`scripts/relevant-check-policy.ts`) whenever packages, automation, or `konsistent.json` itself change. The staged pre-commit path runs `pnpm run fetch:pr-base` before `pnpm agent:check -- --staged` so PR-targeted checks use the latest base branch available from `origin`/the configured remote, then only relevant architecture/test/doc lanes run before CI.


## Validation failure policy

Failed validation is not an acceptable completion state. If a check fails, either fix the failing code/configuration in the same change or clearly stop and report that the task is blocked; do not commit or present the work as complete while required checks are failing.

Use the staged targeted path for pre-commit-sized work:

```bash
pnpm agent:check -- --staged
```

Use broader build-impacting checks only when intentionally validating a branch/root tooling change, not as a default staged hook substitute.

## Documentation maintenance rule

Whenever a change touches code, automation, package metadata, CI, hooks, or agent tooling, update the matching documentation in the same change. At minimum, check whether `README.md`, `docs/design/index.md`, `docs/agent-tooling.md`, and the relevant proof/contract README still describe the current state. If no user-facing docs change is needed, add or update the closest maintenance note so reviewers can see that docs were considered.

Local and CI gates enforce this with `pnpm run docs:freshness`: code changes under `src/`, `scripts/`, `test/`, package metadata, workflows, or agent config must be accompanied by a docs change. The repo hook in `.githooks/pre-commit` runs `check:relevant:staged` through `scripts/run-script.mts` (its root-script gates need no package manager; the turbo package-test lane a workspace-package change selects, and scripts that call pnpm themselves, still need pnpm and refuse the commit without it), which routes to the smallest relevant architecture, test, docs, traceability, and contract lanes; enable it with `pnpm run prepare-hooks` (the root `prepare` script does it on install, and the session-start hooks of Claude Code, Codex, Cursor and Copilot do it through `scripts/ensure-hooks-path.sh` whenever `core.hooksPath` is unset; see `docs/agent-tooling.md`).

## Legal hygiene rules

These are cheap to honor and expensive to unwind. See
[`docs/plans/0009-legal-compliance-audit.md`](docs/plans/0009-legal-compliance-audit.md).

- **Licence metadata is enforced.** Every workspace manifest declares `"license": "MIT"`, and every publishable package (no `"private": true`) ships a `LICENSE` listed in its `files` array. `pnpm run licenses:check` gates this, and also rejects a production dependency whose licence is not on the allowlist in `scripts/check-licenses.ts`. Add a new licence there with a review note rather than working around the gate.
- **No third-party logos.** Naming a vendor is nominative fair use; reproducing its logo or brand mark is not. Do not add third-party logos or brand assets to the site, docs, or README without explicit review. Word marks in prose are fine.
- **Never imply endorsement.** Nothing in docs, site copy, or marketing may state or suggest that HoBo is affiliated with, endorsed by, sponsored by, or certified by any provider.
- **Third-party facts carry a source and a date.** Prices, free tiers, and vendor terms transcribed into this repo are *ranking input, never billing input*. Tag them with the source URL and the date a human checked them (`COST_SOURCE`, `PROVIDER_TERMS`); never fabricate an attestation field like `signedAt` that implies the vendor signed something.
- **Provider-terms invariants ([ADR-0129](docs/design/adr/07-portability-extensibility.md#adr-0129)).** Registered providers are the operator's own accounts. Never pool, share, or resell free-tier headroom across tenants; never create provider accounts or rotate identities to reset a free tier. Rotation is *across providers*, never *across accounts within a provider*.
- **No unsupported compliance claims.** SOC 2, ISO 27001, GDPR, HIPAA, PCI, and similar certifications stay unclaimed until an owning evidence surface accepts them.

## Keys & risks (read before enabling gbrain)
- **gbrain needs an initialized embedding provider.** `gbrain init --pglite` can use local Ollama with no key or egress. Remote `OPENAI_API_KEY` / `ZEROENTROPY_API_KEY` / `VOYAGE_API_KEY` providers receive embedding/query text and may cost money; don't send them sensitive content. Configure remote keys via `.env` (see `.env.example`).
- **Serena / headroom / RTK / improve / caveman / ponytail / superpowers** need **no keys** and run locally; superpowers has optional telemetry (set `SUPERPOWERS_DISABLE_TELEMETRY=1` to disable).
- **SkillOpt** is installed from `microsoft/SkillOpt`; its default sleep mock backend is no-spend, but real `codex`, `claude`, OpenAI, Azure OpenAI, Qwen, or MiniMax backends use the credentials/budget you configure.
- **caveman** was installed via a `curl … | bash` shim (forwarding to `npx github:JuliusBrussee/caveman`); the pinned installer is handled in `scripts/setup-agent-tools.sh`.
- Committing `.mcp.json` / `.cursor/mcp.json` means opening this repo in Claude Code or Cursor will prompt to launch the `serena`, `headroom`, and `gbrain` MCP servers. Decline if you don't want them.

## MCP wiring (per agent)
- **Claude Code** — `.mcp.json` (auto-discovered) defines `serena` + `headroom` + `gbrain`.
- **Cursor** — `.cursor/mcp.json` (same three servers).
- **Codex** — trusted projects load `.codex/config.toml`; copy its `[mcp_servers.*]` tables into `~/.codex/config.toml`, or run `codex mcp add …`, only for a global fallback (see the setup script).

Progressive setup: run `bash scripts/setup-agent-tools.sh --common-only --no-gbrain` first (this is also the devcontainer default), then run `bash scripts/setup-agent-tools.sh --agent claude-code|cursor|codex|copilot --no-gbrain` only for the client you actually use. Shared MCP launchers should live in `scripts/` first (for example `scripts/agent-mcp-serena.sh`) and then be referenced by `.mcp.json`, `.cursor/mcp.json`, and `.codex/config.toml`. When one agent-specific config changes, update the other supported configs in the same commit or document why it does not apply. Skills (`repo`, `draft`, `improve`, `caveman`, `ponytail`) live in `.claude/skills/` (Claude Code) and `.agents/skills/` (Cursor + Codex). ponytail is invocation-based here (`/ponytail …`), not always-on — run `/ponytail` to activate it for a session (it can be made always-on via `/plugin install ponytail@ponytail` in Claude Code if you want that).

## Superpowers plugin (Claude Code · Codex · Copilot)
`superpowers` is a **plugin** (not a skills-dir install), from the `obra/superpowers-marketplace`. It's wired repo-portably for **Claude Code** via [`.claude/settings.json`](.claude/settings.json) (`extraKnownMarketplaces` + `enabledPlugins`), so it auto-enables when you open the repo. For **Codex** and **GitHub Copilot CLI**, install per-machine (the setup script runs these if those CLIs are present):
```
# Claude Code (also: handled by .claude/settings.json):
claude plugin marketplace add obra/superpowers-marketplace && claude plugin install superpowers@superpowers-marketplace
# Codex CLI:
codex plugin marketplace add obra/superpowers-marketplace && codex plugin install superpowers@superpowers-marketplace
# GitHub Copilot CLI:
copilot plugin marketplace add obra/superpowers-marketplace && copilot plugin install superpowers@superpowers-marketplace
```
Skills load at **session start** (a SessionStart hook), so enable it, then start a fresh session to use `brainstorming`, `writing-plans`, `requesting-code-review`, etc.

<!-- caveman:begin — terse-output directive. Caveman mode is INSTALLED and ON by default.
     To disable: delete `.cursor/rules/caveman.mdc`, remove this block, and run
     `npx -y github:JuliusBrussee/caveman -- --uninstall`. -->
## Caveman mode (active)
Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan. Stop: "stop caveman" or "normal mode".
Auto-Clarity: drop caveman for security warnings, irreversible actions, or a confused user. Resume after.
Boundaries: code/commits/PRs written normal.
<!-- caveman:end -->

## Performance-first command policy

Never use tests for discovery. Search first.

Use this ladder:

1. `pnpm run search "<exact text>"`
2. `pnpm run search:structure --filter <rule>` or `pnpm exec ast-grep run -p "<pattern>" -l ts`
3. `pnpm run test:smoke <single test file>`
4. `pnpm run test:file <single test file>`
5. `pnpm run test:name "<test name>" <single test file>`
6. `HOBO_CHECK_BASE=origin/main pnpm run test:changed`
7. `pnpm run test:affected`
8. `HOBO_CHECK_BASE=origin/main pnpm run validate:local`
9. `pnpm run validate:final`

Rules:

- Do not run `node --test` during implementation.
- Do not run `scripts/run-tests.ts --category=*` during implementation.
- Do not run `--test-concurrency=1` with more than one file.
- Do not run broad globs like `test/*.test.ts`.
- Do not run provider and consumer contract suites as diagnostics.
- Do not retry the same slow command after timeout.
- Do not run coverage, artifact generation, or full contract suites unless doing final validation.
- Prefer Bun for smoke tests when compatible.
- Prefer Vitest for normal local validation.
- Prefer Node only for final compatibility validation.

### Sibling consumption (pins)

Everything HoBo takes from a sibling repository is pinned in `tools/pins/siblings.json` and handled by one script, `scripts/bootstrap-siblings.mts` (erasable TypeScript, node builtins only, so it runs before `pnpm install`; ADR-0169). A consumer takes the narrowest artifact: source linked into the workspace is a submodule, an executable is a hash-pinned release asset, a process boundary is a contract. Nothing is built from a sibling's source here.

- `pnpm run pins:fetch [name...]`: a git pin (`ts-autocode`) is a shallow `git submodule update` of exactly the gitlink (`-- --reference <local clone>` downloads nothing that clone has); an asset pin (`mirror`, `opensesame-kit`) is a release file, hashed while it streams and kept in `${XDG_CACHE_HOME:-~/.cache}/siblings/<sha256>/`. When the pin names an `archive` (a `.tar.gz` and the `member` in it), the archive is the file verified; only then is that one regular-file member unpacked to the pin's `entry`, always `0755` (the header's mode is not used: setuid bits are dropped, a `0644` member is still made executable; the parity with `tar` covers names and bytes, not modes). The archive is read once, every byte hashed against the pin before the entry is kept. No archive name ever becomes a path. Refused, so that the reader never names other bytes than `tar -xzf` would put at the member: a member that is not a regular file; two entries that are one file on a case-insensitive file system (`mirror` and `MIRROR`, NFC and NFD spellings, or one name twice), because macOS and Windows would let the second overwrite the first; a name holding a default-ignorable code point (`mi\u200drror`), which HFS+ and some Linux casefold kernels drop; any link, anywhere; a name tar would not extract exactly as written, or not find by that name (one that starts with `/`, has an empty, `.` or `..` segment or a backslash, or is a regular file ending in `/`); an entry under the member, or anything but a directory above it; any entry type but a regular file or a data-less `3` to `6`; a numeric header field in any form but octal digits between spaces and NULs (tar reads others differently: NBSP is no space to it); pax and GNU long-name headers; and any header but POSIX ustar, GNU-format ones included. The whole gzip stream is checked, CRC and trailer included, and what is inflated only to be skipped is bounded (ADR-0169, amended 2026-10-31). An asset with no release yet is `null`: point `MIRROR_BIN` / `HOBO_OPENSESAME_KIT` at a local build.
- `pnpm run pins:status [-- --online]`: offline drift check (gitlink against the checkout, a clean tree, `.gitmodules` against the manifest, cached bytes re-hashed); exit 1 prints what fixes each problem. Run it before trusting a lane that uses a sibling.
- Only `packages/grounding`, `packages/training` and `packages/rewrite` of the `ts-autocode` submodule are workspace members (ADR-0128), and they are its sparse cone in `tools/pins/siblings.json`, so `pins:fetch` checks out only them and the root files: a new import from another of its packages is a workspace, lock and cone change first. After a `ts-autocode` bump, `node --import tsx --test scripts/test/ts-autocode-consumer-surface.test.ts` (`agent:check` selects it for the gitlink, `pnpm-workspace.yaml`, `tools/pins/siblings.json`, or a changed TypeScript file under `packages/` that names a `ts-autocode` module) checks every name HoBo's packages (sources and tests) import from a `ts-autocode-*` package against the pinned source, a value import against a value export, including subpath, dynamic and `import("…")` type references, and that every ts-autocode package those depend on is a workspace member too; it reads the submodule's source, so it needs the checkout, not a build. `agent:check` runs `scripts/test/ts-autocode-grounding-drift.test.ts` with it, which compiles `packages/runtime/src/training/granular.ts` against the pinned grounding source as it is and with each upstream change its header lists: drifts it expects to fail (`methodRef` or `intent` renamed or made optional; `contract.ref` or `params` retyped; `methodRef`, `intent`, `contract.ref`, `params`' values, `contract.input`'s values, `contract.output`, a field description's `description`, the output or its `returns` retyped to `any`; a field description's `example` removed; a field added by name or by symbol to the options, the contract, the output or a field description; the output's `returns` or `params`' values typed as a field description with a field added; `params` or `contract.input` keyed by symbols too; a declared shape given a field that is not JSON, or a symbol key on the shape, on an object one field down, on one member of a union (the shape descriptor's or `contract.output`'s) or on the shape a type-alias shape descriptor holds of itself; a metadata parameter retyped), and changes that drop nothing, which it expects to compile (a shape field holding an array of a type-alias shape; a type-alias shape descriptor that holds itself in an array, beside `null` or through a second alias; a JSON field added to input shapes only; `returns` or `params`' values typed as a union with a field description that has no `example`); changes to `packages/runtime/src/json.ts`, `packages/runtime/src/training/types.ts`, `packages/runtime/tsconfig.json` or `tsconfig.base.json` select both too.
- `pnpm run pins:bump <name> <ref>`: a git pin moves and stages its gitlink; an asset pin reads the release's `SHA256SUMS`, downloads each file to check it and rewrites only its entry. A release that ships Go-named archives (`<name>_<tag>_linux_amd64.tar.gz`) instead of `<name>-<target>` is pinned by the archive. The member is the one the pin already names, else the pin's `entry`; pass `--member <path>` for another. It refuses a repository the manifest did not name, an ambiguous `.gitmodules`, a submodule path that is not a repository of its own (or whose repository was made for another upstream, or is another section's), a commit the remote does not serve, and (unless `--force`) work committed inside the submodule; an asset bump refuses to drop a target without `--drop`. Never edit a pin by hand and never `git submodule update --remote`. `HOBO_PINS_NET_TIMEOUT_MS` (default 120000, at most 600000) bounds every network wait, a whole clone included. The pins run git without a terminal and without `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` and the other repository-locating variables (so they behave the same from a git hook): if your git config rewrites the https remotes to ssh, the key must be in ssh-agent and the host in `known_hosts`. A submodule path that is a symbolic link is refused. `MIRROR_BIN` / `HOBO_OPENSESAME_KIT` name a binary nobody verified: in CI (`CI`, `GITHUB_ACTIONS` or `TF_BUILD` set) `pins:status` and `pins:fetch` exit 1 while one is set, unless `HOBO_PINS_ALLOW_OVERRIDE=1`. Nothing else refuses them: a lane that reads the variable itself (the OpenSesame adapter's real-kit lane, landing separately, does) must run `pins:status` first to get the same refusal.

## Testing policy

This repo does not use traditional E2E tests. Do not add `test:e2e`, `e2e/`, or Playwright tests that require real downstream services.

Allowed browser-driven tests must use mocked service boundaries derived from Pact contracts, protobuf/CUE schema fixtures, or shared contract fixtures. Playwright may be used only as a browser driver, not as a full-stack E2E framework.

Use these lanes instead:

- `pnpm test:unit` for unit tests.
- `pnpm test:types` for type-level checks.
- `pnpm test:schema` for protobuf/CUE/schema compatibility and generated contract checks.
- `pnpm test:contract:consumer` for consumer Pact-style contracts.
- `pnpm test:contract:provider` for provider verification against mocked dependencies.
- `pnpm test:dom` for DOM/rendered state tests.
- `pnpm test:component` for real-browser component behavior with mocked service boundaries.
- `pnpm test:behavior` for Gherkin/Cucumber or Playwright-driven behavior specs with Pact-derived mocks.
- `pnpm test:visual` for deterministic visual state regression.
- `pnpm test:chaos` for the resilience suites described under "Chaos lanes" below.
- `pnpm eval:agent:mock` for deterministic agent evals.
- `pnpm test:property` for fast-check control-plane oracles in `@hobo/fuzz` (simulators only).
- `pnpm test:fuzz` for Jazzer-shaped serialized-input smoke (does not start a long campaign).
- `pnpm test:fuzz:nightly` for the docker-gated RESTler/Toxiproxy/Testcontainers plan. Skip without Docker. Never live Azure/AWS/GCP/paid SaaS.
- `pnpm test:mutation` for the mutation-score gate. Scoped on purpose — see "Mutation testing" below.

### Fixture paths: never a made-up directory at the filesystem root

A test that hands code `hoboHome: "/nonexistent/..."` (or a `cwd`, `home` or
`HOBO_HOME` of that shape) only holds while the code reads the path. The session
store, event journal and one-time-action store create the directory they are
given, so a run as root, which every CI container is, makes `/nonexistent/...` on
the host and leaves it there; later suites that use `/nonexistent` to mean
"missing" then find a directory. Make the directory with
`mkdtempSync(join(tmpdir(), ...))` in `beforeAll` and remove it in `afterAll`
(`rmSync(dir, { recursive: true, force: true })`). The same goes for the other
names tests use for a root that is not there: `/nowhere`, `/no/such`,
`/definitely/not`, `/does-not-exist` and `/missing`. A path the code never
writes to (a PATH entry, an executable that must fail to launch) is listed in
`ALLOWANCES` in `test/fixture-paths-at-root.test.ts` with the line of source
that shows it, and that file scans every test source and fails on any other
such literal.

### Characterization (approval) tests — for generated artifacts

Rule-based tests assert *behaviour* ("an unknown category is rejected").
Characterization tests assert *output* — the exact bytes a generator emits.
Anything in this repo that **writes a committed file a human later reads** needs
one, because rule tests do not notice a changed column, a dropped separator, or
a re-ordered sort: they notice only what they were told to look for, and a
generator's whole surface is what it produced.

The repo's Verify/ApprovalTests equivalent is vitest's **`toMatchFileSnapshot`**,
with the approved artifact committed under a sibling `__snapshots__/` directory:

```ts
await expect(renderMatrix(CORPUS, NOW)).toMatchFileSnapshot(
    path.join(here, "__snapshots__", "competitor-matrix.md"),
);
```

Non-negotiables, because approval testing dies the same way every time:

- **Approve a fixed fixture, never live data.** Snapshotting the real corpus
  repaints the approved file on every unrelated change and trains everyone to
  run `-u` without reading the diff. Build a small fixture that exercises the
  branches which vary the output.
- **Keep the snapshot in its own file, in its target format.** The approved
  artifact for a markdown generator is reviewable markdown. Inline snapshots
  bury it in a test file where nobody reads it as the thing it is.
- **The generator must be a pure function of its inputs.** A `Date.now()`,
  `Math.random()`, or filesystem read inside the renderer makes the output
  unapprovable — inject the clock or the data instead. If a snapshot needs
  regenerating on a schedule, the code under it has a testability defect.
- **`vitest -u` is a deliberate act.** A changed snapshot in a diff is a
  reviewer asking "did you mean to change what 90 documents look like?"

Reference implementation: `test/competitor-docs.characterization.test.ts`.

### Mutation testing

`pnpm test:mutation` runs Stryker. Line coverage proves a test *executed* a
line; mutation score proves a test would **notice** if that line changed.

It is scoped deliberately, not aspirationally: each config names the specific
modules where a silently-passing test is most dangerous — parse boundaries that
guard credentials, transport reach, canonical ordering, and the validators that
gate other lanes. Mutating everything would take far longer than anyone will
wait, and a gate nobody runs is not a gate. Configs carry a `_baseline` comment
recording the measured score and the date; raise `thresholds.break` as the score
improves rather than setting a number nobody can pass.

### Chaos lanes, and which one proves what

Run them with `pnpm test:chaos`. The suites long predated that lane and until
recently had none — they executed only as a side effect of a package's broad
test run, so "is the chaos surface green?" was not a question anyone could ask
directly. The lane keys on the `chaos` marker already present in their filenames.

Two chaos suites exist and they are **not** interchangeable. Conflating them is
how a suite ends up proving neither half.

- **`packages/hobo/test/chaos-conformance.test.ts` — breadth across providers.**
  Its worlds are hand-written, which is what lets it cover every provider's
  resolvers cheaply. What it cannot do is prove the provider actually answers
  that way; the fake answers the way its author believed.
- **`packages/hobo/test/pact-chaos-conformance.test.ts` — depth against the
  contract.** It runs `runPactChaosMatrix` over `pactBackedTransport(pact, {
  lifecycle })`: every fault at every call index, plus a double-fault scenario
  and teardown-under-fault, driving the **shipped** driver rather than a
  pattern reproduced in the test file. It asserts two properties — convergence
  and fidelity — and both are computed from the pact.

**Both properties, or neither is worth much.** *Convergence* asks "did a retry
land exactly one resource?". *Fidelity* asks "was every request you sent on the
way there one the contract declares?" — recorded path, recorded body, recorded
headers. A driver recovering from a lost response takes a branch its happy path
never takes, and a convergence-only lane is blind to that branch talking
nonsense. Ship it and it is a 400 on the first real retry.

**A pact can prove convergence when the corpus records both states.** An earlier
version of this section said it could not. That was wrong, and the way it was
wrong is worth keeping: it generalised from *one interaction* — the name-filtered
lookup, recorded only in its pre-create form (`result: []`) — to the *document*,
which also records `list all zone records` holding `rec1`. Absent and present
were both there; only the sequencing was missing. `PactLifecycle` supplies the
sequence by naming which **recorded interaction** answers which request in which
state, so no response body originates in the harness. Where a state
substitution could quietly lie — answering a filtered read with a collection
body — `assertFilterConsistency` refuses to build the world at all.

**Say "hand-authored", not "provider-verified".** These pacts are consumer
expectations written in this repo, reviewed and shared across every consumer of
a provider. That is a real upgrade over a private fake per test — being wrong
about the provider becomes visible to everybody at once — but no provider has
verified them, and they are not captured traffic. A chaos lane over a pact
proves the driver honours the contract the repo agreed on. It is not evidence
about the live API.

**Duplication rules only apply when the provider mints the id.** A `PactLifecycle`
declares `identity`. `provider-minted` (the default, and the stricter reading) is
the dangerous shape — a POST to a collection, where issuing the write twice
leaves two resources — and it is what every duplication rule in the matrix looks
for. `client-supplied` is a PUT to a path the caller already named: repeating it
after a lost response is not duplication, it is *the correct recovery*, and a
matrix that flagged it would fail a driver for behaving properly. Convergence is
still asserted there, by the observed result and the final state. Getting this
wrong in the permissive direction is the dangerous one, so a lifecycle that says
nothing gets the rules that can only produce false alarms.

**Both lanes ship a negative control.** Every assertion is of the form "no
violations", which a suite that quietly stopped checking also satisfies. The
pact lane runs a deliberately blind-writing subject and asserts it *is* reported,
plus the same subject relabelled `client-supplied` and asserts it is not — which
pins the identity gate in both directions.

Non-negotiables for either lane:

- Faults must be observed to fire (`fired` non-empty). A scenario whose fault
  never landed is a green test about a situation that never happened.
- `countUnmatched()` must be zero, and `fidelityViolations()` empty — otherwise
  a green run means the calls fell through to `PACT_NO_INTERACTION` and the
  suite tested the mock.
- The matrix's own scenario count is asserted. A matrix that silently ran zero
  scenarios satisfies "no violations".

### Which command is the repo-wide gate

`pnpm run test:all` (turbo, one vitest config per package) is the only command
that runs every suite the way its own package intends — with that package's
environment, setup files and process isolation. `pnpm run test:unit` is the
category runner and the default PR lane.

`test:smoke` and `test:file` share one command (`vitest run --no-isolate`) and
one root config. **They are single-target tools, not a full-repo gate.** Run bare
over the whole worktree, the root config puts every package's suites in one
process with `isolate: false`, so suites that pass alone interfere with each
other — `site/src/lib/examples`, `packages/componentize`, and the
`hobo-componentize` draft proofs all pass under their own configs and fail in a
shared run. A red bare-root run is not by itself evidence of a regression;
reproduce under the owning package before believing it.

The root config excludes three things it cannot execute, each of which runs
elsewhere: `external/` (vendored third-party source — `external/ts-autocode` is a
git submodule with its own CI), `dist/` (build output, where every compiled
`*.test.js` is a staler duplicate of a source test that already runs), and
Playwright specs (`@playwright/test`, driven from `packages/pixel-village`'s own
`playwright.config.ts`). Before that exclude existed a bare root run reported
~40 failures on a clean tree, which is enough noise to hide a real one.

Tests that require a binary or hardware **fail rather than skip** when it is
absent — `packages/runtimes/runtime-celld/test/live-*.test.ts` says so in the
error text. That is deliberate: a live lane that silently passes without its
subject is worse than one that stops.

`turbo.json` runs `envMode: "strict"`, so a task sees only what
`globalPassThroughEnv` lists. Two consequences worth knowing before diagnosing a
lane as flaky:

- **TLS and proxy settings are passed through.** Behind a TLS-intercepting
  proxy the certificate chain terminates in the proxy's own root, so without
  `NODE_EXTRA_CA_CERTS` (and the `SSL_CERT_*` / `*_PROXY` family) every
  network-touching task fails `SELF_SIGNED_CERT_IN_CHAIN` while the identical
  command run outside turbo succeeds. That discrepancy reads as a flaky network
  test and is not one. `NODE_TLS_REJECT_UNAUTHORIZED` is deliberately **not**
  passed through: the fix for an untrusted chain is to trust the right root,
  never to stop checking.
- **A live lane's own configuration must be listed too.** `CELLD_BIN` and
  `CELLD_ESBUILD` are passed through, because the celld lane's README and its
  failure message both tell you to set `CELLD_BIN` — and under strict mode that
  instruction silently did nothing. If you add a live lane that reads an
  environment variable, add it here or the escape hatch you documented will not
  exist.

The request guard lives in `@hobo/core` — `guardTransport` for the wrapper,
`assertAllowedEndpoint` for the URL check, `encodesPathSeparator` for the one
rule the transports that cannot use the whole guard still need. Provider
transports delegate rather than reimplement.

Be precise about what the rule catches, because the obvious example is wrong:
WHATWG resolves dot segments during parsing and treats `%2e` as a dot, so
`/v9/projects/%2e%2e/user/tokens` arrives as `/v9/user/tokens` and an ordinary
prefix check refuses it unaided. What survives parsing is an encoded
*separator* — `%2f` and `%5c` — so `/v9/projects/%2f%2e%2e%2fv3/user/tokens`
keeps the prefix, passes `startsWith`, and is decoded only by the origin. That
is the gap the local copies had. Packages keep their own error
type by translating `TransportGuardError` at the boundary, so the thrown type
and code a call site matches on do not change.

On the shared guard: `provider-vercel`, `provider-netlify`, `provider-neon`,
`provider-ttl-sh`, plus `aws`/`azure`/`gcp`/`cloudflare`.

Four are deliberately **not**, and the count matters because "consolidate the
eight" is the wrong target — three of them hold a property core's policy does
not model, so migrating would drop a security property to hit a number:

- `provider-upstash` matches hosts by **suffix** (`.upstash.io`) for its
  per-database data-plane origins; core matches exact hosts only.
- `provider-kubernetes` carries `allowInsecureLoopback`, a deliberate dev
  affordance permitting http on the loopback address.
- `provider-browser-wasm` enforces **same-origin** rather than a host
  allowlist, plus `allowInsecureLocalhost`.
- `provider-kafka`'s `transport.ts` is a broker seam (produce/fetch/commit),
  not an HTTP transport, and never carried a request guard at all.

The first three still want the encoded-traversal refusal, added locally rather
than by migration. Extending `TransportGuardPolicy` with host suffixes and an
insecure-loopback escape would let them share the guard, and that is a design
decision rather than a refactor.

Two things core gained from this that are worth knowing. `TRANSPORT_METHODS`
includes `HEAD`, without which a registry transport cannot be expressed at all
(the OCI distribution spec uses it to ask whether a manifest exists). And
`TransportGuardError` carries a `detail` map, so a redirect refusal names its
target — bounded and stripped of control characters, because that value is
chosen by the peer and ends up in logs.

Credentials are **not** passed through, and the provider tests do not need them
to be: `CLOUDFLARE_API_TOKEN`, `VERCEL_TOKEN` and friends are saved, set, and
restored by the tests themselves rather than read from the ambient environment.

Live service checks and `pnpm eval:agent:live` are manual/release-only lanes. Default PR and agent checks must not require live external services. Default `agent:check` must not run long Jazzer campaigns, RESTler, or Toxiproxy.

Run the smallest sufficient lane through `pnpm agent:check`; no-arg mode validates the latest commit, `--staged` validates staged files, and `--base=origin/main` validates the whole PR branch. It never selects E2E, avoids broad unit/contract sweeps unless final/all validation explicitly asks for them, and escalates only to schema, contract, UI, behavior, visual, mock-agent eval, or bounded property lanes based on changed files.

## Cursor Cloud specific instructions

Durable, non-obvious notes for this environment. The startup update script already runs `corepack enable pnpm` + `pnpm install --frozen-lockfile`, so dependencies are ready; do not re-add install steps here. **HoBo CI Fabric** on self-hosted `hobo` runners uses the hermetic **`hobo-ci-worker:local`** image (mise OCI + base Dockerfile); jobs preflight with `.github/actions/ci-runner-preflight` — no workflow `setup-node` / `setup-cue`. Rebuild on the box with `bash packages/ci-gh-actions/deploy/ci-runner/build.sh` (see `packages/ci/RUNNER-QUEUE.md`). Workflow env: `NODE_OPTIONS=--max-old-space-size=6144`, `HOBO_TURBO_CONCURRENCY=2`.

- **No sudo.** `sudo` is never available and never allowed. Do not run it, do not ask the user to run it, do not suggest root apt/system Docker installs. Prefer `$HOME/.local/bin`, npx/pnpm, remote anon APIs. Host is **aarch64** — download ARM64 binaries only. No `/var/run/docker.sock` here.
- **Examples Temporary = browser-only.** End users never run CLI setup (docker/wrangler/openpouch/crane). Ship is browser → same-origin `/api/cf-temp/*` → remote HTTPS APIs. Do not treat local CLI image push/deploy as a product fallback.
- **No server/GUI.** This is a design-docs + executable proof/contract repo (see README "Current state"). "Running the app" means the validation/lint/test tooling, not a web/backend service. Verify the environment with `pnpm run doctor`, `pnpm run lint`, `pnpm run standards:check`, `pnpm test`, and the doc validators listed in `README.md` "How to work in this repo".
- **Node version.** Local Node 22 satisfies `engines` (`>=22`); CI uses Node 24. Optional Windows bins are not fetched on Linux (`pnpm.supportedArchitectures.os` is `current`).
- **Developer inner loop for a single proof package:** `pnpm exec turbo run test --filter ./src/draft/<kind>/<slug>` (see `src/draft/AGENTS.md`). The turbo "no output files found" warning on `test` is expected (no build outputs) and not a failure.
- **`test:smoke` runs Vitest** (`vitest run --no-isolate`), same engine as `test:file`; there is no bun dependency. Both are single-target tools — see "Which command is the repo-wide gate" above before reading a bare root run as a regression.
- **`tgrep` is not installed**, so `pnpm run search` falls back to `rg`. Always pass explicit path args (e.g. `pnpm run search "pattern" src docs`); running it with no path scope over the full worktree can be very slow.
- **All local gates pass clean on `main`** (`lint`, `standards:check`, `architecture:guard`, `docs:okf`, `docs:cli-lint`, `docs:design-lint`, `docs:coverage`, `docs:freshness`, SDK/deployment validators); treat any failure as caused by the change under test, not the environment.
