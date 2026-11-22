# OptimizeXP skill references

Progressive-disclosure bundle for the optimizexp skill. Route by need; do not load every file every run.

## Core (every run)

- [flags.md](flags.md) — experience include/exclude grammar + `--init`
- [init.md](init.md) — repo traversal → product personas + feature scaffolds
- [metrics.md](metrics.md) — harm metrics + HCD
- [positive-metrics.md](positive-metrics.md) — delight metrics (excitement / ease / optimality)
- [cognitive-thresholds.md](cognitive-thresholds.md) — load channels + persona thresholds
- [equilibrium.md](equilibrium.md) — Pareto stop: harm floor → delight max under constraints
- [persona-models.md](persona-models.md) — KYC-lite demographic/psychographic + segments
- [persona-survey.md](persona-survey.md) — pseudo survey → feature requests
- [experiment-backlog.md](experiment-backlog.md) — rank/auto-apply uplift experiments
- [metric-scorecard.md](metric-scorecard.md) — formal `scores` (+ optional `positive`, `cognitive`)
- [agent-bus.md](agent-bus.md) — write-ahead expect / act / outcome log
- [review-loop.md](review-loop.md) — dual regime until pareto-equilibrium
- [personas.md](personas.md) — `.optimizexp/personas/*.md` → review prompts (schema v2; formal `experiences:` binding)
- [config.md](config.md) — global + project `config.json` (defaults, surfaces, safety, prefer lists)
- [features.md](features.md)
- [feature-quality.md](feature-quality.md) — critical path: rubber-duck, adversarial, catalog
- [app-exploration.md](app-exploration.md) — surface-map
- [doctor.md](doctor.md) — check / repair / snapshot workspace health
- [evidence.md](evidence.md) — what personas see; overwrite + media policy
- [harness.md](harness.md) — capture drivers and CLI
- [pr-delivery.md](pr-delivery.md) — incremental commits, stacked PRs, post evidence
- [workflow-generation.md](workflow-generation.md) — author and regenerate agent workflows

## UX (user experience)

- [ux/design-systems.md](ux/design-systems.md) — design-system inventory and audit patterns
- [ux/design-md.md](ux/design-md.md) — implemented tokens and contrast gates

## DX (developer experience)

- [dx/build-systems.md](dx/build-systems.md) — build graphs, monorepo tooling, incremental builds
- [dx/lint-typecheck.md](dx/lint-typecheck.md) — lint + typecheck feedback loops
- [dx/testing.md](dx/testing.md) — test lanes, smoke-first policy, contract/behavior tests
- [dx/dev-tools.md](dx/dev-tools.md) — local CLIs, doctor scripts, IDE/agent shims
- [dx/repo-package-hierarchy.md](dx/repo-package-hierarchy.md) — repo and package layout
- [dx/caching.md](dx/caching.md) — artifact and remote cache patterns
- [dx/git-hooks.md](dx/git-hooks.md) — git hooks, extensions, staged gates

## AX (agent experience)

Load [**ax/index.md**](ax/index.md) first (section map + load order), then only the surfaces under review:

| Section | File |
|---|---|
| Specs & standing contracts | [ax/specs.md](ax/specs.md) — AGENTS, WorkOS AUTH.md/auth.md, UI tokens, llms.txt, env examples |
| MCP | [ax/mcp.md](ax/mcp.md) — servers, shared fail-closed launchers |
| Agent skills | [ax/agent-skills.md](ax/agent-skills.md) — progressive disclosure, mirrors |
| Harness CLIs | [ax/harness-clis.md](ax/harness-clis.md) — setup, doctor, agent:check, host CLIs, sdlc --finish |
| Model routing | [ax/model-routing.md](ax/model-routing.md) — model/backend choice, cost, live vs local |
| Token optimization | [ax/token-optimization.md](ax/token-optimization.md) — caveman, headroom, RTK, skill size |
| Instruction files | [ax/agents-md.md](ax/agents-md.md) — AGENTS.md / CLAUDE.md structure |
| Host agents & config | [ax/agents-config.md](ax/agents-config.md) — Claude/Cursor/Codex/Grok, subagents |
| Hooks & plugins | [ax/hooks-plugins.md](ax/hooks-plugins.md) — SessionStart, Superpowers, always-on rules |
| Auth (WorkOS auth.md) | [ax/auth.md](ax/auth.md) — agent registration protocol + residual local tooling keys |

## Cross-agent (hosts without native workflows)

- [cross-agent/deterministic-workflows.md](cross-agent/deterministic-workflows.md) — shared template to call deterministic code workflows
- [cross-agent/vercel-wdk.md](cross-agent/vercel-wdk.md) — Workflow DevKit / local Worlds notes

SKILL.md keeps Codex-valid frontmatter; OKF concept metadata lives in these references
(validated by `pnpm run docs:okf`; mirror equality by `pnpm run skills:mirror-check`).
