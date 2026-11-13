---
type: Agent Tooling Reference
title: "Agent tooling"
description: "Thirteen third-party AI-coding tools plus repo-local repo, draft, sdlc, and optimizexp skills are wired into this repo for Claude Code, Cursor, Codex, and GitHub Copilot CLI."
tags: [hobo, agent-tooling.md]
---

# Agent tooling

Thirteen third-party AI-coding tools are wired into this repo for **Claude Code**, **Cursor**, and **Codex** (Superpowers also targets **GitHub Copilot CLI**). This page is the reference; the at-a-glance table + always-on caveman directive live in [`../AGENTS.md`](../AGENTS.md). Install the binaries with [`../scripts/setup-agent-tools.sh`](../scripts/setup-agent-tools.sh). The repo-local `repo`, `draft`, `sdlc`, `gh-stack`, and `optimizexp` skills are mirrored in `.agents/skills/` and `.claude/skills/` (all configured agents: Claude Code, Cursor, Codex, Grok, etc.); use `repo` for lifecycle work, `draft` for draft taxonomy and gate-enforced proof artifacts, `sdlc` to coordinate the full development loop (brainstorm → plan → one-shot issues → subagents with incremental checkins → parent-owned GitHub stacked PRs → bottom-up rubber-duck/adversarial review → comment/check repair → per-PR squash-merge), `gh-stack` for non-interactive `gh stack` CLI rules, and `optimizexp` for persona-driven UX/DX/AX experience optimization (write-ahead agent bus + **review→reduce experiment→verify** each pass by default; derived fixes must ship in-run; no iterations/pass budget; true plateau = flat scores **and** empty implementable backlog; `--report-only` to measure without edits; schema-v2 personas, evidence-checked scorecards (`evidenceChecks`/`justification`), product-CLI feature coverage under `.optimizexp/features/cli-product/`, drift gate `pnpm run optimizexp:check`; config under [`.optimizexp/`](../.optimizexp/README.md); **AX** progressive refs under [`.agents/skills/optimizexp/references/ax/`](../.agents/skills/optimizexp/references/ax/index.md) — specs, MCP, skills, harness CLIs, model routing, token optimization, hooks, auth). Invoking OptimizeXP grants standing approval for safe, in-scope preflight repairs; destructive, networked, secret-bearing, and unrelated actions still require separate authority.

OptimizeXP native captures persist the replay command's exit code, mark nonzero runs degraded, and promote only media created or changed by that command; a stale or generated image/video alone is not successful evidence.

> **Note:** this is *tooling* config, not part of the HoBo product design (`docs/design/`). It was added on request to make the agents productive in this repo.

The [default dev container](../.devcontainer/devcontainer.json) installs **mise** (pinned Node, pnpm, cue, gitleaks, turbo from [`../mise.toml`](../mise.toml)) on a **digest-pinned** Node 24 Bookworm base (see
[`.devcontainer/Dockerfile`](../.devcontainer/Dockerfile)), plus GitHub CLI, Docker in Docker, native Actions runner dependencies and pinned act. Personal dotfiles install via [`../scripts/bootstrap-dev.sh`](../scripts/bootstrap-dev.sh) (see [`dev-env/mise.md`](dev-env/mise.md)).
It starts the local CI runner controller on every container start. Missing
credentials/configuration leave it waiting while offline checks remain usable.
See [local CI setup, trust, lifecycle and recovery](../packages/ci-gh-actions/LOCAL-DEVELOPMENT.md)
for the `local` provider and `HOBO_CI_LOCAL_*` settings. Persistent host runners use
`hobo-local-host`; only HoBo's reserved JIT runners use `hobo`.

## Product implementation guardrails

Agents implementing HoBo code must follow the canonical architecture rules in [`../AGENTS.md`](../AGENTS.md): every service boundary is pinned by PACT contracts; records, messages, data shapes, and objects are defined in protobuf with CUE constraints; runtime code parses into derived types instead of validating broad values in place; and flows use CQRS, event stores, materialized views, and actors. Actors consume commands, emit events, and coordinate durable state. Query paths use rx-style projections with cached current snapshots and persisted historical snapshots in a read store.

The fail-fast check is `pnpm run architecture:guard` (`architecture:guard:staged` when the pre-commit gate selects it). It scans changed `src/draft/<kind>/<slug>` implementation packages for PACT, protobuf, CUE, parse-don't-validate, and event-architecture evidence before the slower test and CI gates run.

The full compatibility gate is `pnpm run validate:final`, which runs standards and the same `test:unit` graph as `check:all`. [`../scripts/run-unit-tests.ts`](../scripts/run-unit-tests.ts) asks turbo for exactly the legacy root/draft Vitest set: four root shards selected by stable path hash and nine draft shards selected by a stable hash of each proof package directory (`src/draft/<kind>/<slug>` or `src/draft/exp-proofs/<type>/<slug>`). It does not run production `packages/**` suites (Workspace tests owns them) or `scripts/test/` (`test:scripts` owns them). Every shard uses [`../scripts/run-tests.ts`](../scripts/run-tests.ts) with the canonical root settings, and a shared turbo dependency supplies the builds the legacy pretest supplied. The coverage guard requires exact set equality, rejecting missing, extra, and duplicate files, and proves a proof directory never spans shards. `pnpm run test:unit:shards` regenerates the per-proof turbo inputs and draft shard scripts; `pnpm run test:unit:shards:check` rejects drift. Turbo parallelism follows `HOBO_TURBO_CONCURRENCY` (default `100%`); root runners honor `HOBO_TEST_MAX_WORKERS`, then `HOBO_RELEVANT_CHECK_CONCURRENCY` (default `4`). Package-scoped runs stay on `pnpm exec turbo run test --filter=./<workspace>`.

Agent edit loops should not use Node test suites for discovery or broad diagnostics. Use `pnpm run search <text>` for exact indexed search, `pnpm run search:structure --filter <rule>` or `pnpm exec ast-grep run -p <pattern> -l ts` for AST search, then the narrowest compatible test command: `pnpm run test:smoke <file>` when Bun can run it, `pnpm run test:file <file>` or `pnpm run test:name <name> <file>` for normal local feedback, `HOBO_CHECK_BASE=origin/main pnpm run test:changed` for changed-scope validation, and `pnpm run validate:final` only after implementation is complete. `scripts/run-tests.ts` refuses broad agent edit-loop categories when `CI_AGENT`, `CODEX`, `CLAUDECODE`, or `CURSOR_AGENT` is set unless `--final` is passed, and `scripts/run-relevant-checks.ts` refuses broad root unit/contract scripts unless the caller explicitly passes `--final` or `--all`. Root `pnpm run lint:code` formats **`scripts/` and `test/` only** (Biome); keep those trees format-clean when editing automation.

## The thirteen tools

### improve — `shadcn/improve` (MIT)
A **read-only agent skill**: surveys the codebase and writes prioritized, self-contained implementation **plans** to `plans/`, which git ignores (they are never committed), for other (cheaper) agents to execute. It never edits source. Commands: `/improve`, `/improve quick`, `/improve deep`, `/improve security|perf|tests|bugs`, `/improve branch`, `/improve next`, `/improve plan <desc>`, `/improve execute <plan>`, `/improve reconcile`. No API keys. Installed to `.claude/skills/improve` (Claude Code) and `.agents/skills/improve` (Cursor + Codex).

### superpowers — `obra/Superpowers` (MIT)
A **plugin** (skills library + methodology), v6.0.3, from the `obra/superpowers-marketplace`. Adds a structured development workflow — **brainstorming** (design refinement via questions), **writing-plans**, **test-driven-development**, **systematic-debugging**, **subagent-driven-development**, **requesting/receiving-code-review**, **using-git-worktrees**, **verification-before-completion**, **dispatching-parallel-agents**, **finishing-a-development-branch**, `using-superpowers`, `writing-skills` (14 skills total). **No API keys** (optional `SUPERPOWERS_DISABLE_TELEMETRY=1`). A `SessionStart` hook loads the skills, so **enable, then start a fresh session**.
- **Install (per agent):** Claude Code is wired repo-portably via [`../.claude/settings.json`](../.claude/settings.json) (`extraKnownMarketplaces` + `enabledPlugins`) — opening the repo auto-enables it. Codex / Copilot install per-machine: `<agent> plugin marketplace add obra/superpowers-marketplace && <agent> plugin install superpowers@superpowers-marketplace` (the setup script runs these when those CLIs are present). Unlike the skills tools, this is a **global plugin**, not committed skill files.

### mattpocock/skills — `mattpocock/skills` (MIT)
A **skills collection** of engineering disciplines, installed via the `skills` CLI to `.claude/skills/` (Claude Code) and `.agents/skills/` (Cursor + Codex). Highlights: **`grill-with-docs`** ("a relentless interview to sharpen a plan or design, which also creates docs — ADRs and glossary — as we go"), `domain-modeling`, `codebase-design`, `design-an-interface`, `diagnosing-bugs`, `tdd`, `to-prd`, `to-issues`, `request-refactor-plan`, `prototype`, plus model-invoked `grilling`. **No API keys.**
- **Configure (one-time):** run `/setup-matt-pocock-skills` in your agent to set up its issue-tracker / triage-label vocabulary / domain-doc layout (optional for a docs repo; skip if you don't use the issue-tracking skills).
- Used in this repo to **close competitor gaps** — see [`docs/competitors/gap-analysis.md`](./competitors/gap-analysis.md) and the resulting design work.

### caveman — `JuliusBrussee/caveman` (MIT)
A **skill + always-on rule** that compresses the agent's **output** (~65–87% fewer tokens) while preserving technical accuracy. Commands: `/caveman [lite|full|ultra|wenyan]`, `/caveman-commit`, `/caveman-review`, `/caveman-compress <file>`, `/caveman-stats`. No API keys. Installed to `.agents/skills/caveman*` (+ `cavecrew`), `.cursor/rules/caveman.mdc` (`alwaysApply: true`), a `## Caveman mode (active)` block in `AGENTS.md`, and (for Claude Code) a global `claude` plugin. Optional env `CAVEMAN_STATUSLINE_SAVINGS=0`.
- **It is ON by default.** To disable: delete `.cursor/rules/caveman.mdc`, remove the `<!-- caveman:begin … end -->` block from `AGENTS.md`, and run `npx -y github:JuliusBrussee/caveman -- --uninstall`.

### impeccable — `pbakaus/impeccable` (Apache-2.0)
A **design skill** for AI harnesses (npm `impeccable`, v3.5.0, homepage
[impeccable.style](https://impeccable.style)). 23 commands spanning the design
workflow — `shape`, `critique`, `audit`, `polish`, plus dials like `bolder`,
`quieter`, `colorize`. **Standing duty on visual work** (TUI, dashboard,
Evidence, `site/`, any package `DESIGN.md`): run `critique` then `audit`
(and `polish` on P0/P1) and `pnpm run design:lint` without being asked.
See `AGENTS.md` “Design system + lint”. **No API keys**, but it is **not**
offline — see egress below.
- **Network egress (three paths, one of them automatic):**
  - `scripts/context.mjs` calls `impeccable.style/api/version` when it is run
    **as a command** (`node scripts/context.mjs`, i.e. the skill's context
    step) — on by default, throttled to once a day. The per-edit **hook does
    not fetch**: `hook-lib.mjs` imports only `extractPlatform`/`loadContext`,
    and the fetch sits behind `cli()`, which runs only when the file is invoked
    as a script. Measured 0 requests from `hook.mjs` in both repo root and a
    subdirectory, including the absolute-path Copilot variant. Disabled here
    by **`IMPECCABLE_NO_UPDATE_CHECK=1`**, set in
    [`../.claude/settings.json`](../.claude/settings.json) `env`. That is the
    control that actually holds: upstream reads
    [`../.impeccable/config.json`](../.impeccable/config.json)'s
    `"updateCheck": false` relative to `process.cwd()`, so the file alone
    covers repo-root sessions and **not** `cd site && …` — verified by driving
    the real code path with a stubbed `fetch` (subdirectory: 1 request with the
    config alone, 0 with the env var). Both are in place. Run
    `npx impeccable check` deliberately instead.
  - **Residual, stated rather than papered over:** `.claude/settings.json` is
    Claude Code's file. A **Codex / Cursor / Copilot** session that runs an
    impeccable command from a subdirectory gets neither control and will still
    make that once-a-day request. `.codex/config.toml` has no env facility and
    direnv is not used in this repo, so there is no mechanism here that would
    close it without inventing one. The exposure is a version string, once a
    day, from those harnesses only.
  - `scripts/generate-image.mjs` posts to `api.openai.com` — opt-in, only when
    you invoke it, and it needs your own key.
  - `scripts/concept-seed.mjs` calls `impeccable.style/api/roll` — opt-in.
- **Hooks (ON by default):** the install writes `PostToolUse` manifests to
  `.codex/hooks.json`, `.cursor/hooks.json` and `.github/hooks/`, which run the
  design detector after **every** `Edit`/`Write`/`apply_patch`. Each is guarded
  (`[ ! -f <script> ] || node <script>`) so it no-ops when the skill is absent.
  **Claude Code deliberately gets no hook** — this repo manages
  `.claude/settings.json` itself and the installer does not write a `hooks` key
  there. To remove the others, delete those files; `npx impeccable install`
  rewrites them.
- **Install:** `npx impeccable install` from the repo root; it auto-detects
  harnesses and compiles **per harness** into `.claude`, `.agents`, `.cursor`
  and `.github`. `npx impeccable check` reports drift, `npx impeccable update`
  applies it. Committed, like the other skills.
- **Init:** `/impeccable init` writes `PRODUCT.md` (product truth only). It does
  **not** write `DESIGN.md` — [`site/DESIGN.md`](../site/DESIGN.md) remains the
  design authority ([ADR-0149](./design/adr/07-portability-extensibility.md#adr-0149)),
  and its context loader reads that file as incumbent authority. Do not run
  `/impeccable document` at the repo root: a root `DESIGN.md` would auto-opt-in
  the root to `design:lint` and introduce a fourth identity beside the three
  that gate validates.
- **Mirror-gate exemption:** impeccable is listed in `VENDORED_SKILLS` in
  [`../scripts/check-skill-mirrors.ts`](../scripts/check-skill-mirrors.ts). The
  byte-identical rule fits skills this repo authors; impeccable deliberately
  emits Codex-only `agents/*.toml` and `agents/openai.yaml`, so forcing the
  trees equal would corrupt the install and be undone by the next update.

### Higgsfield MCP — `mcp.higgsfield.ai` (hosted, official)
The **official hosted** MCP connector for Higgsfield AI image/video generation
(30+ models). Registered in [`../.mcp.json`](../.mcp.json) as an HTTP server at
`https://mcp.higgsfield.ai/mcp`.
- **Auth:** account **OAuth**, not an API key — **no credential is stored in
  this repo**. Sign in via `/mcp` in Claude Code.
- **Approval:** project-scoped MCP servers start as *pending approval*; a human
  must approve the server before it can be used. That is deliberate and cannot
  be done on your behalf.
- **Risk:** generation requests and any prompt content are sent to Higgsfield.
  Treat it like the other network-egress tools in this table.

### higgsfield-auth — repo-local skill
Mints and rotates the Higgsfield MCP token. **The standard OAuth flow cannot
complete here**: Higgsfield chooses between two flows `client_capability_based`,
Claude Code is listed under `authorization_code_pkce`, and that path needs
`http://localhost:<port>/callback` pre-registered with their Clerk tenant — it
is not, so `clerk.higgsfield.ai` *and* Higgsfield's own `/oauth2/authorize`
proxy both reject it with `redirect_uri does not match…`. Running `/mcp`
reproduces the error rather than fixing it.

The skill uses their **`device_code`** flow instead (endpoints published in no
`.well-known` path — only in the service's OpenAPI doc) and installs the result
as a plain `Authorization: Bearer` header.

```sh
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs ensure   # refresh only if needed
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs status   # 0 healthy / 2 due / 1 none
node .claude/skills/higgsfield-auth/scripts/hf-auth.mjs login    # device flow, needs the user
```

- **Access tokens last one hour**, refresh tokens 7 days — and each refresh
  rolls that window, so a running daemon makes one `login` effectively
  permanent. `ensure` refreshes if due *and* starts the background refresher.
- The daemon is **single-instance via an O_EXCL lock**, because two loops would
  consume each other's rotated tokens and break the chain. It logs to
  `~/.higgsfield/daemon.log` and exits rather than spinning when the refresh
  token is dead.
- The daemon **re-verifies its claim every iteration**, not just at startup, and
  exits when it has lost it. Claiming once is not enough: a machine suspended
  past the staleness window has already been taken over by whoever ran `start`
  on wake, and a heartbeat that silently no-ops would leave two loops consuming
  each other's rotated tokens. `stop` deliberately ignores the staleness filter,
  since "no daemon running" while one is running is the one answer it must never
  give.
- The lock holds a **uid and is heartbeated**, not just a pid. Pids are
  recycled, so a dead daemon's pid reappearing as an unrelated process would
  make `kill(pid, 0)` report it live forever and wedge `start` until a manual
  `stop`; `EPERM` did the same. A lock idle past 45 minutes is therefore
  abandoned regardless of its pid — safe, since a live holder never sleeps more
  than 15. Takeover is confirmed by re-reading the uid, so two starters
  recovering from the same abandoned lock cannot both claim it.
- **Refresh tokens rotate on every use** and the old one dies immediately.
  Never call `/refresh` with curl during a session — that consumes the stored
  token and the next `ensure` fails. The store is written atomically at `0600`,
  and the response is **merged over** it rather than replacing it: a refresh
  that returns no new `refresh_token` (the ordinary non-rotating shape) would
  otherwise erase the stored one and force an interactive login.
- Credentials live in `~/.higgsfield/token.json` and `~/.claude.json`, **never**
  in the committed `.mcp.json`.
- Restart Claude Code after `login` or a header-changing `refresh`.

### ponytail — `DietrichGebert/ponytail` (MIT)
A **minimalist-coding skill**: channels a senior dev who pushes the laziest solution that works — YAGNI (does this need to exist?), standard library before custom code, native platform features before dependencies, one line before fifty. Commands: `/ponytail [lite|full|ultra]`, `/ponytail-review` (review a diff for over-engineering), `/ponytail-audit` (whole-repo bloat scan), `/ponytail-debt` (harvest `ponytail:` shortcut comments into a ledger), `/ponytail-gain`, `/ponytail-help`. **No API keys; no third-party data transmission.** Installed (6 skills) to `.claude/skills/ponytail*` (Claude Code) and `.agents/skills/ponytail*` (Cursor + Codex).
- **Invocation-based here, not always-on.** Run `/ponytail` to activate it for a session. (Upstream also supports an always-on plugin install via `/plugin marketplace add DietrichGebert/ponytail` → `/plugin install ponytail@ponytail` in Claude Code; we use the skills route to keep it opt-in and committable, and to avoid stacking a second always-on directive on top of caveman.) Optional global config: `~/.config/ponytail/config.json` or `PONYTAIL_DEFAULT_MODE`.


### tgrep — `microsoft/tgrep` (MIT)
A **trigram-indexed grep** for fast exact/regex search in large local checkouts. It is a local binary with no keys and no data egress. Use `pnpm run search <pattern>` before tests or semantic search. The setup script installs it in the common/devcontainer layer when possible: existing `tgrep` wins; otherwise it tries a GitHub release download through `gh`, then `cargo install --git https://github.com/microsoft/tgrep.git --locked tgrep-cli`, then a curl/python GitHub API release download for common Linux/macOS architectures.

### ast-grep — `ast-grep/ast-grep` (MIT)
A **structural search and rewrite** tool for AST-shaped queries. The repo pins `@ast-grep/cli` as a dev dependency, allows its postinstall in `pnpm-workspace.yaml`, commits `sgconfig.yml`, and exposes `pnpm run search:structure` for configured scans. Use ad hoc patterns with `pnpm exec ast-grep run -p '<pattern>' -l ts` when you do not need a committed rule. The devcontainer recommends the VS Code ast-grep extension.

### Serena — `oraios/serena` (MIT)
A **semantic-code MCP server**: it gives coding agents IDE-like symbol search, reference lookup, and safer symbol-aware edits/refactors through language servers. It is agent/harness agnostic because it speaks MCP; this repo exposes one shared launcher, [`../scripts/agent-mcp-serena.sh`](../scripts/agent-mcp-serena.sh) (fails closed with setup remediation when the binary is missing), and points Claude Code, Cursor, and Codex at that wrapper instead of duplicating hard-coded commands. The launcher keeps runtime state under the gitignored checkout `.serena/runtime` and disables Serena's optional dashboard windows so read-only homes and port-restricted agent sandboxes can still start the stdio server; an explicit `SERENA_HOME` or trailing launcher arguments override those defaults. The setup script runs the idempotent `serena init` even when the binary is already installed. Codex gives local MCP servers 30 seconds to initialize because Serena's first project scan can exceed Codex's 10-second default. The Vitest agent-tooling test guards the launcher environment and dashboard flag; Protobuf, CUE, and PACT are not involved in this local shell boundary. No API keys. Serena may install/use language-server dependencies for the languages in the checkout.

### RTK — `rtk-ai/rtk` (Apache-2.0)
A **Rust Token Killer command proxy** that compresses noisy shell-command output before it reaches coding agents. It is local, uses no API keys, and supports direct use (`rtk git status`, `rtk pnpm test:file <file>`, `rtk gain`) plus hook initialization for Claude Code/Copilot (`rtk init -g`), Codex (`rtk init -g --codex`), and Cursor (`rtk init -g --agent cursor`). The setup script installs it in the common/devcontainer layer when possible (existing `rtk`, Homebrew, Cargo, then upstream install script) and initializes hooks only in the selected agent-specific layer.

### headroom — `chopratejas/headroom` (Apache-2.0)
A **token-compression MCP server** (also a CLI/proxy) that shrinks the **context fed to the model** — tool outputs, logs, file dumps — reversibly (`headroom_retrieve` fetches originals). Local-first, **no API keys**. MCP tools surface as `mcp__headroom__headroom_compress|retrieve|stats`. Repo MCP configs launch via [`../scripts/agent-mcp-headroom.sh`](../scripts/agent-mcp-headroom.sh) (fails closed with setup remediation when the binary is missing). For automatic compression of *all* traffic you can also run the proxy: `headroom proxy --port 8787` then `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` (optional; see `headroom mcp --help`).

### gbrain — `garrytan/gbrain` (MIT)
A **knowledge-graph memory MCP server** (+ CLI) on the **Bun** runtime: `gbrain capture` ingests notes, `gbrain search`/`query` does hybrid retrieval + synthesis. Repo MCP configs launch via the shared fail-closed wrapper [`../scripts/agent-mcp-gbrain.sh`](../scripts/agent-mcp-gbrain.sh) (not bare `gbrain serve`) so a missing binary or initialized provider prints remediation pointing at [`../AUTH.md`](../AUTH.md) instead of a host "command not found". The wrapper also reaps PGLite locks whose recorded PID resolves to a non-gbrain process in the current agent PID namespace while preserving real live gbrain holders; the agent-tooling Vitest covers this namespace-crossing case. Run `gbrain init --pglite` once; local Ollama is the zero-key/local-data path.
- ⚠️ **Optional keys + data egress + cost:** remote providers use exactly one of `OPENAI_API_KEY` / `ZEROENTROPY_API_KEY` / `VOYAGE_API_KEY` (in `.env`) and receive embedding/query text. Don't point them at content you don't want shared. Local Ollama keeps embeddings local. The PGLite store is gitignored. To disable gbrain entirely, decline its MCP server or run setup with `--no-gbrain`.


### spriterrific — local CLI skill (**prefer this one**)
The Spriterrific **CLI**, installed on this machine as a `uv` tool
(`uv tool install spriterrific`, currently **0.20.2**) and self-installing its
skill with `spriterrific skill install --target all`. That command owns
`.claude/skills/spriterrific`, `.agents/skills/spriterrific` and
`.codex/skills/spriterrific`; re-run it with `--force` to upgrade rather than
hand-editing, and note it does **not** write `.cursor/` or `.github/`.

- **Requires** `FAL_KEY` in the gitignored `.env`, Python 3.11+ (uv provides it),
  and `ffmpeg` for the video workflows. All three are present.
- Generation bills **fal.ai directly**, per image and per video.

**Prefer the local skill over `spriterrific-api`.** They drive the same engine,
and the local one is the better default here for concrete reasons:

1. **Review gates.** It writes a run folder with a review page, contact sheets
   and per-stage artefacts you can look at before anything is promoted. The
   hosted API returns URLs; the CLI hands you the evidence.
2. **The anchor never leaves the machine unreviewed.** Facing, snap contract
   and candidate height are checked locally, and a bad anchor is caught before
   it is animated — which is where the cost is.
3. **Reproducibility.** The run folder records prompts, seeds, model aliases and
   costs beside the output, so a result can be re-derived.

Reach for `spriterrific-api` only when the local CLI genuinely cannot run — no
`FAL_KEY`, no Python, a machine without the tool — or when the user explicitly
asks for the hosted queue. Say which one you used and why.

**Runs are not committed.** `.gitignore` carries a repo-wide `runs/` rule; run
folders are large, machine-specific and reproducible. Commit the *promoted*
asset, not the run that made it.

**Bo is asymmetric, and `--auto-orient` is a mirror.** It defaults to **on** and
silently flips a wrong-way anchor to canonical, which hands Bo's bindle to the
wrong arm. Always pass `--no-auto-orient` for him and read the facing line
yourself. The engine assumes **W-authored** art (screen-left), so source a west
anchor from `site/public/parallax/bo-walk-left.png` — a drawn west sheet — never
by flipping the east one.

### spriterrific-api — `chongdashu/spriterrific-skills`
Drives the **hosted Spriterrific HTTP API** — text prompt or reference image to
game-ready 2D character anchors and animation spritesheets, generated on
Spriterrific's cloud workers rather than a local checkout. Installed to all four
skill trees (`.claude`, `.agents`, `.cursor`, `.github`) from
`raw.githubusercontent.com/chongdashu/spriterrific-skills`, byte-identical, at
**v1.3.2**.

- **Auth:** `SPRITERRIFIC_API_KEY` (a `sk_…` bearer token, created at
  app.spriterrific.com). Kept in the gitignored `.env`, never in-repo.
- **It spends real money.** Jobs debit credits *up front*: an image step
  (anchor) is 30 credits, a video step (one action animation) is 100. A
  character job from a prompt is `3x30 + actions x100`; from a reference image
  `2x30 + actions x100`; a variant `2x30 + actions x100`; an extra action job
  100. Failed or skipped steps auto-refund, and 400s cost nothing. **Check
  `GET /api/v1/me` and state the expected debit before enqueueing.**
- **Risk:** prompts, reference images and generated artifacts go to
  Spriterrific's service and its upstream providers (nano-banana-2-lite for
  images, grok-imagine-video-1.5-i2v for video).
- Frame re-picking, version listing and activation are **0 credits** — reach for
  those before re-rolling a generation.
- The companion **CLI** skill (`spriterrific`, for local checkouts with review
  gates) is **not** installed here; this is the hosted surface only.

**For Bo specifically:** the skill's own anti-patterns matter more than usual,
because Bo is asymmetric and text prompts cannot pin identity. Never rebuild him
from a fresh `sourcePrompt` or an externally generated lookalike to change an
outfit or a facing — use a **character variant job** (`referenceJobId` +
`editPrompt` naming only the delta), which preserves face, proportions and art
style. A new facing is a variant job with a new `direction`, never a mirror.

### SkillOpt — `microsoft/SkillOpt` (MIT)
A **skill optimization research harness**, not a runtime MCP server. SkillOpt treats a markdown skill as trainable external state for a frozen agent: it runs scored rollouts, proposes bounded add/delete/replace edits, accepts only validation-improving candidates, and exports a compact `best_skill.md`. It currently targets direct chat plus Codex CLI and Claude Code CLI harnesses. Use it offline when the repo has scored tasks or benchmark suites worth optimizing against; do not put it in always-on agent instructions. The setup script installs it directly from `git+https://github.com/microsoft/SkillOpt.git`, verifies `skillopt-train` and `skillopt-sleep`, and exposes [`../scripts/skillopt-sleep.sh`](../scripts/skillopt-sleep.sh) as the repo-local runner. Use the default mock backend for no-spend dry runs, then opt in to `--backend codex` or `--backend claude` when you want real replay on your own budget.

### anti-slop — `dmmulroy/anti-slop` (MIT)
**Opinionated Oxlint rules** that reject low-evidence/low-signal TypeScript patterns (chained type assertions, `unknown` parameters/returns, ad hoc `typeof` narrowing, module mocking, unjustified `as` casts, …). The plugin is **vendored, not an npm dependency**: it lives at [`../tools/oxlint/anti-slop/`](../tools/oxlint/anti-slop/) and is wired into [`../oxlint.config.ts`](../oxlint.config.ts) with every generic rule at `error`. Full-repo `pnpm run lint:slop` stays opt-in because of a large pre-existing backlog. Pre-commit and `agent:check` instead run `pnpm run lint:slop:changed` (`scripts/lint-slop-changed.mts`) on the TS/JS files a commit or PR actually touches, with `--deny-warnings`, so new violations cannot land. The lane fails closed (exit 2) when git cannot list the changed files (an unfetched or unknown `--base`, no repository), rather than reading that as an empty diff and reporting itself clean ([`scripts/test/lint-slop-changed.test.ts`](../scripts/test/lint-slop-changed.test.ts)). **Where it actually runs:** hosted Actions are off (see the README's CI section), and the preserved `pr-gate` job only reaches the lane through `agent:check`, so on this repository the pre-commit hook is the one automatic run. The hook is installed by the root `prepare` script; a checkout installed without lifecycle scripts, or a worktree sharing another checkout's `node_modules`, never runs it, and `git commit` is then ungated. Agent sessions close that gap themselves: [`scripts/ensure-hooks-path.sh`](../scripts/ensure-hooks-path.sh) sets `core.hooksPath` to `.githooks` in the repository's common git config (`git rev-parse --git-common-dir`, so every worktree shares it) when it is unset. It never replaces a value someone chose, acts only on this checkout's own repository (a copy with no `.git` of its own leaves an enclosing repository alone), ignores a `GIT_DIR` or `GIT_COMMON_DIR` it inherits (git exports one to hooks in a linked worktree), prints nothing, always exits 0, and is skipped when `HOBO_SKIP_HOOKS` or `CI` is `1`, `true`, `yes` or `on` (not `0` or `false`), as `scripts/install-hooks.mts` is. **Branches older than this hook path:** a branch whose `.githooks/pre-commit` predates `6c957806` still runs `pnpm run …` from it, so once any session has set `core.hooksPath`, a commit on such a branch needs a usable pnpm. Merge `main` into the older branch before committing on it. Setting `HOBO_SKIP_HOOKS=1` before a session starts keeps that session from setting the path, but an old hook already in effect does not read it. Every agent this repo configures runs it at session start, each through its own documented event: Claude Code `SessionStart` ([`../.claude/settings.json`](../.claude/settings.json)), Codex `SessionStart` with matcher `startup|resume` ([`../.codex/hooks.json`](../.codex/hooks.json); project hooks load only once the project `.codex/` layer is trusted and the hook is reviewed with `/hooks`), Cursor `sessionStart` ([`../.cursor/hooks.json`](../.cursor/hooks.json)), and Copilot CLI and cloud agent `sessionStart` ([`../.github/hooks/git-hooks-path.json`](../.github/hooks/git-hooks-path.json)). [`scripts/test/session-start-hooks-path.test.ts`](../scripts/test/session-start-hooks-path.test.ts) runs the script and each configured command. Any other tool, or a Codex project that is not trusted, runs `sh scripts/ensure-hooks-path.sh` once per clone. Elsewhere, check with `git config core.hooksPath` (it must print `.githooks`; set it with `pnpm run prepare-hooks`), and run `pnpm run lint:slop:changed -- --base=origin/main` before opening a PR. That gap is how 34 of the 72 TS/JS files changed by the 30 squash-merges after Actions were disabled (#1552–#1581) reached `main` failing this lane; they were cleared afterwards, file by file. The selector in `scripts/relevant-check-policy.ts` chooses that lane for source, automation, `oxlint.config.ts`, or `tools/oxlint/` changes. The bundled `install-anti-slop` skill (mirrored in `.agents/skills/` and `.claude/skills/` via `npx skills add dmmulroy/anti-slop`, covering Claude Code, Cursor, Codex, and GitHub Copilot) handles reinstall/refresh. Each of the three copies (`tools/oxlint/anti-slop` and both skill assets) carries a `MANIFEST.sha256`, and [`scripts/test/anti-slop-vendor.test.ts`](../scripts/test/anti-slop-vendor.test.ts) (in `test:scripts`, and selected by pre-commit and `agent:check` when a copy changes) fails when a copy drifts from its manifest or from the others; [ADR-0173](design/adr/01-architecture-core.md#adr-0173) has the edit and update commands and the measurements behind keeping HoBo's rule lineage rather than OpenSesame's newer one. Local, no keys, no egress.

## Repo-local skills

The **repo** skill is mirrored in `.agents/skills/repo` and `.claude/skills/repo`. Use it for setup, cleanup, search, implementation iteration, validation, commits, PRs, deployment, and final handoff. It encodes the repo's performance-first loop: search before validate, validate changed scope before package scope, validate package scope before repo scope, use fast approximate tools first, and leave exact or slow compatibility tools for final proof. Search defaults to local hybrid retrieval: OKF `index.md` files, `tgrep` when available, `rg`, `fd`, `ast-grep`, `git grep`, and memory or semantic tooling only after exact or structural search narrows the target. It does not use Google ingestion or query products by default; LlamaIndex Index v2 is documented as an optional beta/cloud path, not the default.

The **draft** skill is mirrored in `.agents/skills/draft` and `.claude/skills/draft`. Use it when creating, moving, or reviewing draft proof material under `src/draft/<kind>/<slug>`, including technical proofs, experience proofs, epic proofs, and project MVP rollups.

The **sdlc** skill is mirrored in `.agents/skills/sdlc` and `.claude/skills/sdlc`. Use it for the full development loop. Multi-step work is delivered as **GitHub Stacked PRs** via the official `gh stack` extension; the parent agent owns stack topology and a mandatory **bottom-up closeout** (rubber-duck + adversarial review, all PR comments, status checks, squash-merge per PR). Design-relevant layers also require the exact-six OptimizeXP designer council and a current-head unanimous `assert-yay` immediately before merge; `/sdlc --finish` and billing-only CI exceptions cannot waive that gate. **`/sdlc --finish`** lands the current working session: commit remaining work, rebase on latest trunk, resolve conflicts, open/update PRs, push, and squash-merge every session PR (`references/finish.md`). **Billing/spending-limit CI failures do not block squash-merge** — document them and merge after all non-CI gates pass. Subagents implement one layer each with **incremental checkins**. Details: `references/finish.md`, `references/stacked-prs.md`, `references/dispatch.md`.

The **gh-stack** skill is mirrored in `.agents/skills/gh-stack` and `.claude/skills/gh-stack`. Non-interactive CLI rules for `github/gh-stack` (`gh stack init|add|submit|sync|merge|view --json`). Install: `gh extension install github/gh-stack` (also `scripts/setup-agent-tools.sh` common layer). Docs: https://gh.io/stacks

The **optimizexp** skill is mirrored in `.agents/skills/optimizexp` and `.claude/skills/optimizexp`. Its designer council is an additional append-only protocol for design-relevant SDLC work: exactly `steve-jobs`, `jony-ive`, `walt-disney`, `hayao-miyazaki`, `naoto-fukasawa`, and `shigeru-miyamoto`; one equal binary vote each; unanimous current-head approval only. Synthetic investment decays subjective preference debate without removing objective blockers. `consensus-loop.mts` reconstructs every transition from proposal-rooted bus history, emits rework on any nay, and rejects stale effective bases, heads, manifests, exemptions, or snapshots. Policy-aware SDLC runs must persist either the required council inputs or a deterministic internal-only exemption. See `references/design-council.md` in either mirror.

Repo-local skills keep Codex-valid `SKILL.md` frontmatter. Bundled `references/` directories are Open Knowledge Format concept bundles with OKF metadata in the reference files. `pnpm run docs:okf` validates the docs OKF bundle and the `repo`, `draft`, and `sdlc` skill reference bundles in both mirrors, accepting LF or CRLF frontmatter line endings so Windows-authored docs use the same gate.

## Progressive setup

Start with the common layer, then add one supported agent shim only when you need it:

```bash
bash scripts/setup-agent-tools.sh --help                 # flags only (no install)
bash scripts/setup-agent-tools.sh --common-only --no-gbrain
pnpm run doctor                                          # Node/pnpm + agent-tooling (AUTH/MCP/setup/PATH)
# doctor: missing gbrain is a zero-key warn with pasteable --no-gbrain remediation (see AUTH.md)
# later, choose one supported client:
bash scripts/setup-agent-tools.sh --agent claude-code --no-gbrain
bash scripts/setup-agent-tools.sh --agent cursor --no-gbrain
bash scripts/setup-agent-tools.sh --agent codex --no-gbrain
bash scripts/setup-agent-tools.sh --agent copilot --no-gbrain
```

The common layer installs agent-agnostic runtimes (`tgrep`, repo-pinned `ast-grep`, `rtk`, `serena`, `headroom`, `skillopt-train`, `skillopt-sleep`, and the **`github/gh-stack`** GitHub CLI extension for stacked PRs) and leaves per-agent plugin/skill registration alone. Agent-specific layers only install shims for the selected supported client. Devcontainers run the common layer by default through [`.devcontainer/post-create.sh`](../.devcontainer/post-create.sh), avoiding prompts, global CLI mutations, and optional gbrain setup during container creation.

## Per-agent wiring
| | MCP servers (Serena, headroom, gbrain, Higgsfield) | Skills (improve, mattpocock, caveman, ponytail, impeccable) | Plugin / optimizer |
|---|---|---|---|
| **Claude Code** | `.mcp.json` (auto-discovered) | `.claude/skills/` (incl. mattpocock) | `.claude/settings.json` for Superpowers; SkillOpt can run offline |
| **Cursor** | `.cursor/mcp.json` | `.agents/skills/` + `.cursor/rules/` (caveman) | — (no plugin support) |
| **Codex** | trusted-project `.codex/config.toml`; copy to `~/.codex/config.toml` or use `codex mcp add …` for a global fallback | `.agents/skills/` + `AGENTS.md` | `codex plugin marketplace add/install` (per-machine); SkillOpt can run offline |
| **GitHub Copilot CLI** | — | — | `copilot plugin marketplace add/install` (per-machine) |

Committed so a clone is wired up: `.mcp.json`, `.cursor/`, `.codex/config.toml`, `.claude/skills/`, `.agents/skills/`, shared MCP wrapper scripts, `AGENTS.md`, `CLAUDE.md`, `skills-lock.json`. Opening the repo in Claude Code/Cursor will prompt to start the `serena` + `headroom` + `gbrain` MCP servers — decline if unwanted.

## Install
```bash
bash scripts/setup-agent-tools.sh --help        # flags only (no install)
bash scripts/setup-agent-tools.sh --common-only --no-gbrain # common/devcontainer-safe layer
bash scripts/setup-agent-tools.sh --agent codex --no-gbrain # add one supported agent shim
bash scripts/setup-agent-tools.sh              # common + all supported shims
bash scripts/setup-agent-tools.sh --no-skillopt # skip microsoft/SkillOpt install
```
Requires: Node ≥18 (`npx`/`pnpm`) for ast-grep and skills, Python ≥3.10 (`pip`) for headroom/SkillOpt, `uv` (or Python to install `uv`) for Serena, GitHub CLI, Cargo, or curl/python/tar for tgrep, Homebrew/Cargo/curl for RTK, and Bun for gbrain. Put `$HOME/.local/bin` (RTK, headroom, Serena fallback, SkillOpt CLIs) and `$HOME/.bun/bin` (gbrain) on your `PATH`.

## Trust / provenance
- All thirteen are MIT/Apache-2.0 OSS. `improve`, `mattpocock/skills`, `ponytail`, `superpowers`, `Serena`, `headroom`, `RTK`, and `anti-slop` are local with no egress (superpowers has optional, disable-able telemetry). `caveman` installs via a `curl|bash` shim that forwards to `npx github:JuliusBrussee/caveman`. `gbrain` is the only always-configured MCP tool with third-party data egress + cost; SkillOpt may call whatever model/backend you configure for offline training or sleep runs; its default sleep `mock` backend is no-spend and deterministic.
- `npx skills add … --copy` writes real files (not symlinks) so they're committable and reviewable. `skills-lock.json` pins versions.
- Review skill files before trusting them — they run with full agent permissions.


## Maintenance gates

Agent-tooling changes count as repo behavior changes. Prefer cross-agent config first: shared wrapper scripts under `scripts/`, devcontainer/common-layer setup, shared skills under `.agents/skills/` where supported, then minimal Claude/Cursor/Codex/Copilot shims. When changing one supported agent config (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.claude/settings.json`, or setup scripts), check and update the peer configs in the same PR. Update `AGENTS.md`, this file, or another relevant README in the same change when editing `.agents/`, `.claude/`, `.codex/`, `.cursor/`, `.mcp.json`, or setup scripts. The `architecture:guard`, `docs:freshness`, CI, and `.githooks/pre-commit` gates enforce architecture evidence and documentation freshness before merge. The pre-commit hook auto-installs on `pnpm install` through a `prepare` lifecycle script (`scripts/install-hooks.mts` and `scripts/ensure-ts-autocode-links.mts`, which fail-closed checks that `ts-autocode-grounding` is linked under `packages/runtime/node_modules` and the training cone is present — it never runs nested `pnpm install`, so prepare cannot recurse); it is skipped when `CI` or `HOBO_SKIP_HOOKS` is `1`, `true`, `yes` or `on`, and `pnpm run prepare-hooks` still wires `core.hooksPath` manually. After `pnpm run pins:fetch`, run a normal root `pnpm install` if the check fails. The hook itself is skipped under the same `HOBO_SKIP_HOOKS` values. Each agent's session-start hook (Claude Code `.claude/settings.json`, Codex `.codex/hooks.json`, Cursor `.cursor/hooks.json`, Copilot `.github/hooks/git-hooks-path.json`) runs the one shared `scripts/ensure-hooks-path.sh`, so a change to that behaviour is a change to the script, not to four configs; see the anti-slop section below.

## PR impact classification (shadow)

`scripts/ci/impact-classifier.mts` classifies changed paths as meaningful or inert (identical bytes, canonical-JSON equality, whitespace-only markdown, or an unchanged TypeScript token stream once trivia is dropped; directive comments, JSDoc, shebangs and ASI-significant newlines stay meaningful). The PR impact gate runs it in shadow mode by default (`HOBO_IMPACT_GATE=shadow` repo variable): it only reports the lanes inert paths would drop, and execution is unchanged. `HOBO_IMPACT_GATE=enforce` is currently an alias for shadow — no wiring consumes the classification in any mode. Nothing consumes the meaningful-paths file yet — raw-text-scanning tests (design lint, redaction walks) and known scanner false-inert classes (regex literals, JSX text, newlines inside block comments) make inert enforcement inside `packages/**` unsafe until scan roots are modeled and the tokenizer is parser-driven, so shadow counts are optimistic and are not enforcement evidence; `off` disables classification, and a change to the classifier itself always classifies every path meaningful. The classifier is Node-builtins-only and fail-closed — without a loadable `typescript` package (the pre-install path) code files stay meaningful, and the tokenizer bails to meaningful whenever a scan stops advancing or either side fails to parse (per-extension script kind: TS/TSX/JS/JSX). `scripts/ci/dependent-tests.mts` accepts `--base=` so its root `package.json`/`turbo.json` scoping matches the workflow's `affected-lanes` decision; scripts-only manifest edits no longer widen merge-group workspace tests to the whole workspace. Tests: `scripts/test/impact-classifier.test.ts`, `scripts/test/dependent-tests.test.ts`.

## Code formatting with Biome

`biome.json` drives one repo-wide formatter for TypeScript and JavaScript. Formatting is scoped by `files.includes` to `packages/**`, `scripts/**`, and `test/**`, and deliberately excludes build output (`**/dist/**`, `**/node_modules/**`), generated trees (`**/generated/**`, `**/_generated/**`, `**/.hobo/**`), snapshots (`**/*.snap`), and every `**/*.json` file. JSON is excluded on purpose: the repo pins byte-exact golden manifests, Pact fixtures, and the lockfile, and a formatter pass would break their hashes. Linting stays narrower than formatting — it is disabled globally and re-enabled only for `packages/**` (minus `dist`) via an override, so the pre-existing lint debt under `packages/` is not gated onto unrelated work. Run `pnpm run lint:code` to check formatting and `pnpm run lint:code:fix` to apply it.

## Fast local checks with Turborepo

Pre-commit checks now route through `check:relevant:staged`, which discovers staged files and runs only the gates tied to those paths. Neither the hook nor that runner needs a package manager for root-script gates. Both start root scripts through [`scripts/run-script.mts`](../scripts/run-script.mts) (Node 22, which `engines` requires), which runs a package.json script from the repository root with `node_modules/.bin` first on PATH, as pnpm does, and hands it its arguments as positional parameters (`sh -c '<script> "$@"'`), never as shell text: `node --run` escapes `'` wrongly, so a base branch whose name held `'` and `;` could corrupt the base or run a command ([`scripts/test/run-script.test.ts`](../scripts/test/run-script.test.ts), [`scripts/test/pre-commit-hook.test.ts`](../scripts/test/pre-commit-hook.test.ts)). The runner starts each `pnpm run <script>` gate the policy names that way and each `pnpm exec <bin>` gate from `node_modules/.bin` (`withoutPackageManager` in `scripts/lib/env.ts`, tested in `scripts/test/without-package-manager.test.ts`); an exec of anything but a plain binary name that is installed (an option such as `--filter`, a path, `node`) is refused rather than guessed at, and a gate that cannot start fails with its reason ([`scripts/test/run-relevant-checks-start.test.ts`](../scripts/test/run-relevant-checks-start.test.ts)). Installs, scripts with `pre`/`post` scripts (which the launcher does not run), root scripts that call pnpm themselves (`install:check`, `test:schema`, `test:property`, `test:contract:*`), Windows, and the `turbo` package-test lanes (turbo runs each package's script through the package manager, so any commit touching a workspace package needs it) still need pnpm; without it those gates fail and the commit is refused. Before any gate, the hook checks that the base is a commit (`git rev-parse --verify`); when `fetch:pr-base` fails it shows the fetch's own error and names `HOBO_ARCHITECTURE_BASE=<ref>`, which skips the fetch; and with no `node_modules` it stops with one line naming the install step and `HOBO_SKIP_HOOKS=1`. No-arg `pnpm agent:check` defaults to `HEAD~1`, so a small committed rebase repair validates that latest change instead of replaying every package touched by the whole PR; pass `--base=origin/main` when intentionally validating the full branch against the PR base. Every gate is chosen from that changed-file list, so when git cannot produce it (an unknown or unfetched `--base`, `HEAD~1` in a depth-1 clone, no repository) `agent:check` exits 2 and names the base, instead of reading the failure as an empty scope and printing `ok` ([`scripts/test/run-relevant-checks-git-failure.test.ts`](../scripts/test/run-relevant-checks-git-failure.test.ts)); in a shallow clone it names `git fetch --deepen=1` for a `HEAD~n` base, and in staged mode a `--base` it is given must be a commit, since the gates receive it. `lint:docs:changed` and `lint:docs:staged` fail closed the same way ([`scripts/test/run-linters-git-failure.test.ts`](../scripts/test/run-linters-git-failure.test.ts)). A file list is only as good as the buffer that reads it: Node stops a child whose captured output passes 1 MiB (`ENOBUFS`), and main's `git ls-files` passed that, so `lint:docs` (`--all`) failed with "git could not list the tracked files" while the PR lane (`--base=origin/main`) still passed. The gates that capture a git file list without a bound of their own (`run-linters.ts`, `check-docs-freshness.ts`, `check-technical-standards.ts`) read it with `GIT_OUTPUT_MAX_BUFFER` (64 MiB, `scripts/lib/git-output.ts`), and [`scripts/test/git-output-bound.test.ts`](../scripts/test/git-output-bound.test.ts) feeds each a repository whose tracked and staged lists exceed the default. Draft proof packages under `src/draft/<kind>/<slug>` are treated as independent pnpm workspaces when package-test-relevant content changes under `src/`, `test/`, `tests/`, `type-tests/`, `features/`, `contracts/`, `simulation/`, `scripts/`, package metadata, protobuf, CUE, or Pact fixtures. The router batches all touched workspaces into one `pnpm exec turbo run test --filter=./<workspace> …` invocation: `turbo.json` runs with `envMode: "strict"` (so harness-injected `NODE_OPTIONS` never reaches test processes and cannot poison cache keys), task hashes cover only declared inputs (markdown excluded), and unchanged workspaces replay from `.turbo/cache` instead of re-executing. Move-only taxonomy churn and README/ADR-only edits still flow through architecture, docs, standards, and traceability gates, but they do not schedule every moved proof package. Taxonomy artifact folders without package manifests remain covered by architecture, docs, schema, and standards gates instead of being treated as runnable packages. Protobuf/CUE edits inside draft packages stay on that isolated workspace path; CUE-backed data-model folders must live inside the owning project/package, and root contract/schema edits outside `src/draft/<kind>/<slug>` run repository `test:schema` by default. Broad root unit and consumer/provider contract sweeps are final/all-validation lanes only: pass `--final` or `--all` when intentionally paying for that breadth. Root/shared Pact changes mark contract scope, but default relevant checks stay on architecture, docs, root-test, and schema lanes available from the touched paths; broad consumer/provider verification requires explicit final/all validation. Draft-local Pact changes are covered by the owning workspace test instead of escalating to the global `test:contract` sweep. Root scripts and tests are also type-checked: `pnpm exec turbo run typecheck:root` (root `tsc --noEmit` over `scripts/` and `test/`, with `turbo.json` building `@hobo/bindings`, `@hobo/bindles`, `@hobo/ci`, `@hobo/claims`, `@hobo/connectivity`, `@hobo/core`, `@hobo/dispatcher`, and `@hobo/kv-redis-compatible` first so imports resolve (the list must cover every workspace package root `scripts/`/`test/` type imports reach — clean ephemeral runners have no leftover `dist/` to mask a missing entry)) runs whenever those paths change. Independent relevant checks run after any package-install guard with bounded concurrency of four by default; set `HOBO_RELEVANT_CHECK_CONCURRENCY` when a CI worker can safely run more or less. Expensive global validators stay impact-scoped: traceability runs for traceability/design-proof edits, deployment-set validation runs for that proof, and agent evals run only for eval/prompt paths. Root `package.json` changes that only add or update scripts, lockfile importer-only updates, and root task-graph metadata still run install, root-test, standards, docs, architecture guards, and touched workspace tests, but they do not force the all-package `turbo run build typecheck lint test --filter=[HEAD^...HEAD]` lane unless the caller passes `--build` explicitly. The selector lives in `scripts/relevant-check-policy.ts` so root tests can assert gate choice without executing those gates. The runner has a second guardrail: if selector output includes broad root unit or contract scripts without `--final` or `--all`, it exits before launching them. The relevant-check path also runs `pnpm run case:check` (Windows case-collision preflight), `pnpm run lint:code` (Biome format check), and `pnpm run lint:slop:changed` (anti-slop Oxlint on touched TS/JS, warnings denied) for source or automation changes; tracked paths that differ only by case should be handled as separate Windows hygiene work instead of being folded into unrelated cleanup. The architecture guard enforces a single-lockfile rule on every run: it scans all tracked paths (not only the diff) and fails when any nested `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` exists — only the root `pnpm-lock.yaml` is allowed (`single-lockfile`), because per-package npm installs drift from the workspace resolution pnpm actually uses. The workspace likewise carries one TypeScript: the root `typescript` devDependency. Package scripts call plain `tsc` (the root `.bin` is on `PATH` under pnpm), and tests that compile TypeScript consumers spawn `node <repoRoot>/node_modules/typescript/bin/tsc` — never `npx`/`npm exec` with a pinned `typescript@x.y.z`, which fetched a second compiler from the network at test time. (Seven draft packages whose tests already fail on main keep their legacy pins until those pre-existing failures are fixed.) Turborepo stores cache entries under `.turbo/` and reuses them across Windows, macOS, Linux, and devcontainer runs when inputs are unchanged.

On Windows, `scripts/run-relevant-checks.ts` invokes nested pnpm commands through `cmd.exe /d /c pnpm.cmd`.
This keeps the staged hook path usable in shells where `pnpm` is not directly executable from
`child_process.spawnSync(..., { shell: false })`.

Use these commands when working locally or as an agent:

Use `pnpm run check:changed:build -- --base=<ref>` only when you intentionally need the broad package graph build/typecheck/lint/test lane; the default changed-file agent check stays on impact-scoped install, root tests, docs, standards, and architecture gates.

`standards:check` accepts `--base=<ref>` and falls back to `HEAD~1` when that ref is unavailable in a sandbox checkout without remotes; normal clones should still pass `origin/main` or the PR base.

- `node --experimental-strip-types scripts/run-script.mts check:relevant:staged` (or `pnpm run check:relevant:staged`) before commit; this is the hook path and should stay fast.
- `pnpm run agent:check` after committing a focused fix; it compares the latest commit with `HEAD~1`.
- `pnpm run check:relevant -- --base=origin/main` when intentionally validating the whole branch against the PR base.
- `pnpm run test:fast` for root test-runner smoke checks; it is root-only, quiet, and writes no runner log artifacts.
- `pnpm run test:unit:quiet` when the full unit lane is needed without heartbeat/pass spam or runner log artifacts.
- `pnpm --prefix src/draft/<kind>/<package> test` when editing one draft proof package.
- `pnpm run test:all` only for full-repo verification or before merging large cross-cutting changes.

The non-staged relevant-check runner forwards its selected `--base` into
`docs:freshness` so PR impact checks evaluate the same merge-base file set even
after install or generated-contract steps touch the local working tree.
It also forwards `--staged` to `standards:check` only for staged validation;
latest-commit and PR-base checks use standards' worktree/base mode.
`docs:freshness` ignores every path under `node_modules`, including the
deps-layer symlinks a CI job links into each workspace package.

When merging `origin/main` into an active proof branch, recently merged draft
workspaces may require fresh `pnpm-lock.yaml` importer entries. Keep those
lockfile updates with the merge repair and rerun the normal relevant check path
instead of treating them as unrelated churn.

Agents should prefer the narrowest command that covers the changed files, and should avoid running `pnpm test` or `pnpm run test:all` after edits that touch only one isolated draft package unless a shared script, root dependency, or contract generator changed. Search first (`pnpm run search <text>`, then ast-grep for code shape), run single-file Bun/Vitest feedback during implementation, and reserve the turbo-backed `pnpm run validate:final` for final validation.

### Tooling choice: pnpm + Turborepo

Research pass, 2026-06-29: Bun has the fastest headline installer and is worth revisiting for Bun-runtime packages, but this repo remains Node-based and needs strict monorepo filtering, workspace linking, lockfile auditability, and CI-compatible security gates. pnpm is the best package-manager fit for HoBo because it combines a content-addressable store, strict dependency graph, strong workspace filtering, and mature Node compatibility. Turborepo remains the task runner because it adds cross-package task caching on top of whichever package manager owns installs, without requiring the repo to adopt Vite or Bun as a runtime.

Chosen stack:

- Package manager: `pnpm@10.33.4` via `packageManager` and `pnpm-lock.yaml`.
- Task runner/cache: `turbo@2.8.6` via `pnpm exec turbo`. The pin stays below
  `2.10.x` until the Windows platform package no longer imports an unshipped
  `ghostty-vt.dll`; local and pre-commit gates must run without hidden machine
  DLLs.
- Runtime for checks: Node >=24, matching `package.json` engines.
- Bundler/dev server: none by default; add Vite only for runnable browser apps, not for docs/proof packages where it would add startup and dependency cost without serving a hot-reload UI.
- Bun: not default. Use only for isolated proof packages that deliberately target Bun APIs or can prove Node-compatibility parity and faster measured gates.

pnpm v11 build-script security is configured in `pnpm-workspace.yaml`: only `esbuild` and `protobufjs` may run install-time build scripts. The recent `turbo` and `@typescript/native-preview` platform packages are listed in `minimumReleaseAgeExclude` so the repo can intentionally use current toolchain binaries while retaining pnpm's supply-chain policy checks for the rest of the graph.

### Isolated test temp/log directories

`scripts/run-tests.ts` creates one isolated directory per invocation under the OS temp root, scoped by workspace hash and worker id: `<os-tmp>/hobo-design-tests/<workspace-hash>/<worker-id>/run-*`. Each batch receives its own child temp directory through `TMPDIR`, `TMP`, and `TEMP`, so parallel workers do not share global temp logs or unrelated temp context. Set `HOBO_TEST_TMPDIR` only when a worker needs a different temp base; the runner still creates isolated run and batch children beneath it.

The runner does not write batch logs for passing tests. Failed batches keep a bounded output tail in memory; normal runs persist that failure tail to the isolated batch directory, while `--quiet` or `--no-artifacts` keep it off disk and print it only on failure. Use `pnpm run test:fast` for a quiet, no-artifact root smoke lane. Use `pnpm run test:unit:quiet` for the legacy root/draft unit graph with turbo output limited to errors.

### Fast docs linting

Docs linting follows the same rule as tests: local hooks lint only changed markdown. `pnpm run lint:docs:staged` reads staged paths, skips immediately when no markdown changed, and passes only relevant files into the CLI/design doc linters. It automatically falls back to a full design-doc scan when a shared catalog changes (`cli-spec.md`, glossary, ADR index, event-family catalog, or traceability), because those files can invalidate references outside the touched file set. Full lint remains available with `pnpm run lint:docs` for CI or broad documentation refactors.
