# DX — HoBo

HoBo is a **reference implementation** for the portfolio DX baseline. The canonical standard lives in this repo:

**→ [Monorepo DX Playbook](docs/standards/monorepo-dx-playbook.md)**

## What HoBo already does (the reference stack)
- **pnpm** pinned (`packageManager`) + corepack; supply-chain hardening (`allowBuilds`, `minimumReleaseAge`).
- **Turborepo** with `globalDependencies`, `envMode: strict`, md-ignoring test `inputs`, `--affected`.
- **Biome** (format) + **ast-grep** + **konsistent** (structure).
- **Native git hooks** (`core.hooksPath=.githooks`, fail-open `prepare`); relevant-check `pre-commit` maps changed paths → minimal check set.
- **Thin, affected, env-only CI** (cross-OS SHA-256 digest parity, offline `docker --network=none` gates, gitleaks). No deployment (design-phase).

## Residual improvements (Advanced)
- [x] Turbo remote cache in CI when `TURBO_TOKEN` / `TURBO_TEAM` are set; `actions/cache` fallback on `.turbo/cache`.
- [ ] Optional `commit-msg` lint (neither reference repo has one yet).

See the playbook §12 for the full conformance checklist.
