# CLAUDE.md

The repository-wide rules at the start of [AGENTS.md](AGENTS.md) apply to Claude
and every plugin or skill. Preserve training input comments and track genuinely
unfinished work in Linear before removing its marker or planning document.

**Repo:** HoBo — a cloud-agnostic, AI-native hosting platform: an active design suite **plus a production `packages/` workspace** (140+ package manifests, ~400k lines of non-test TypeScript; S0–S3 stage-gate lanes green). Honest-scope caveats (in-memory Pulumi stand-in default, synthetic componentize bytes, not on npm) live in the README status summary and `docs/design/live-provider-matrix.md`. The design suite is in [`docs/design/`](docs/design/index.md); formal requirements are archived in [`docs/archive/requirements/`](docs/archive/requirements/index.md); competitor research is in [`docs/competitors/`](docs/competitors/index.md). Production packages live under `packages/`; draft proofs and agent tooling remain under `src/draft/` and `.agents/`/`.claude/`/`scripts/`.

## Agent tooling
The repo-local **sdlc** skill coordinates implementation and review under the repository-wide rules; **`/sdlc --finish`** lands the session (commit, merge `origin/main` in, one PR per workstream, merge — never squash — all session work; see the skill's `--finish` section). Companion **gh-stack** skill covers non-interactive CLI; **draft** governs proof material with gate-enforced artifacts (`proof.json`, executed examples, notebooks, cucumber features via `pnpm run test:behavior`).
This repo is wired with the agent tools listed in the docs/agent-tooling.md table for Claude Code, Cursor, and Codex (Superpowers also targets GitHub Copilot CLI) — see **[`AGENTS.md`](AGENTS.md)** for the full table and **[`docs/agent-tooling.md`](docs/agent-tooling.md)** for setup/keys/risks. Quick map:
- **superpowers** (`obra/Superpowers`) — plugin: code-review, TDD, and debugging workflows; planning and design artifacts are prohibited; enabled repo-wide via `.claude/settings.json`; loads at session start.
- **mattpocock/skills** — engineering disciplines incl. **`grill-with-docs`** (design interviews without creating ADRs), `domain-modeling`, `codebase-design`, `tdd`; one-time `/setup-matt-pocock-skills` to configure.
- **caveman** — terse-output compression (active by default; `/caveman` to adjust).
- **impeccable** (`pbakaus/impeccable`) — design skill (23 commands: `/impeccable shape|critique|audit|polish`, dials like `bolder`/`quieter`). **Always-on for UI/TUI/dashboard work** — do not wait to be asked (see **AGENTS.md “Visual quality”**). `PRODUCT.md` holds product truth; visual tokens and components live in source. Do not run commands that generate design documents. Its daily phone-home (from `scripts/context.mjs` run as a command — the hook does **not** fetch) is disabled by `IMPECCABLE_NO_UPDATE_CHECK=1` in `.claude/settings.json`, which covers Claude Code sessions; the config-file opt-out is cwd-relative and misses subdirectories; it installs a per-edit hook for Codex/Cursor/Copilot only.
- **Higgsfield MCP** — official hosted image/video generation (`mcp__higgsfield__*`); account OAuth, no key in-repo, needs human approval before use.
- **spriterrific** (local CLI, `uv tool`) / **spriterrific-api** (hosted) — sprite generation. **Always prefer the local skill**: same engine, but it writes a reviewable run folder and catches a bad anchor before paying to animate it. It reads `FAL_KEY` from its environment; agents never store that key in an environment variable or `.env` file (see the no-stored-secrets rule in AGENTS.md). Runs are gitignored; promote the asset, not the run. **`--auto-orient` is a mirror and defaults on — pass `--no-auto-orient` for Bo.** See AGENTS.md "Generated-art rules".
- **ponytail** — minimalist-solution skill (YAGNI/stdlib-first); `/ponytail`, `/ponytail-review`, `/ponytail-audit` (invocation-based, no keys).
- **headroom** — MCP server compressing context fed to the model (`mcp__headroom__*`).
- **gbrain** — MCP server for knowledge-graph memory (needs `gbrain init` + an embedding key; **sends content to that provider**).

Install the binaries once with [`scripts/setup-agent-tools.sh`](scripts/setup-agent-tools.sh). MCP servers are defined in `.mcp.json` (auto-discovered).

**Dev environment:** provision pinned Node, pnpm, cue, and turbo with [`mise.toml`](mise.toml) (`bash scripts/bootstrap-dev.sh --project-only` or `mise install`). Cloud agents without a custom image should run `bash scripts/bootstrap-dev.sh` first so dotfiles + mise stay current; see [`docs/dev-env/mise.md`](docs/dev-env/mise.md).

## Working norms
- **Agents never store secrets.** No secret or store-configuration env vars, Actions secrets or variables, `.env` or key files, or own credential stores; credentials are `owner://<NAME>` entries in the owner's HoBo store session. See the rule at the start of `AGENTS.md`; `secrets:guard` and the pre-tool hooks enforce it.
- **Do not create plans, roadmaps, or design documents.** Track genuinely unfinished work in Linear and remove its planning artifacts. See the rules at the start of `AGENTS.md`.
- Keep user and operator documentation aligned with behavior in `packages/`; `docs:freshness` checks code changes alongside documentation changes. Move unfinished work from the existing design suite to Linear and remove its planning artifacts.
- Follow the HoBo implementation architecture rules in [`AGENTS.md`](AGENTS.md): PACT at service boundaries, protobuf plus CUE for records/messages/data/objects, project-local `data-models/` folders for CUE-constrained types, parse-don't-validate derived types, and event-driven CQRS/actors/materialized views.
- **Durable EventStore (ADR-0135):** default SQLite behind ports (`@hobo/storage-sqlite`, `@hobo/runtime-local`, `@hobo/runtime-browser`); one partition / one writer; stream-head CAS + fencing; never multi-writer NFS WAL. See AGENTS.md “Portable SQLite EventStore”.
- **Bindle-first + impedance (ADR-0144):** abstract ports via Bindle kinds are the default authoring path; provider escapes are Camp/Yard-scoped and PortabilityReport-scored; check thin-adapter impedance limits before claiming fidelity.
- **Jurisdiction/residency (ADR-0146):** `evaluateResidency` in `@hobo/core` is fail-closed; residency/compliance rules go through the typed jurisdiction port + `@hobo/policy` packs, never ad-hoc region strings. Traits are first-class (ADR-0145): attach operational behavior via manifest `annotations`/the trait-kind map, don't invent mechanism #10.
- **Contract effects (ADR-0136):** optional `EffectSpec` + secondary `ResilienceProfile` on BoundaryContract; effect widening can break can-deploy; never retry `policy.Decided`/terminal; no Effect-TS/Polly/XState public deps. See AGENTS.md “Contract effects + visible resiliency”.
- Site/agents/OKF: design suite under `docs/design/` (OKF bundle; `pnpm run docs:okf`); GitHub Pages from `site/` (Astro → `gh-pages`); agent briefing `site/public/llms.txt` + `/llms-full.txt`.
- Run `npm run architecture:guard` for implementation-package changes; pre-commit runs the staged variant before the slower tests.
- **Design system is standing, not opt-in.** Visual and dashboard edits use the owning package’s tokens and shared components. Run `pnpm run design:lint` and the affected rendered-surface tests. Do not generate design documents. See AGENTS.md “Visual quality”.
- Conventional, scoped commits.
