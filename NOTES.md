# Loop-me notes

## Tools & channels

- **GitHub** — `Tyler-R-Kendrick/HoBo` repo; PRs numbered; Cursor Cloud agents use `cursor/<descriptive-name>-<suffix>` branches
- **Linear** — team HoBo, issue keys `HOBO-N`; projects map to design epics; Done status + PR link comments
- **CI** — Docs + PR impact gate on every PR; `pnpm agent:check -- --base=origin/main` locally
- **Agent permissions** — can merge PRs, push branches, and post PR reviews via Cursor Automation MCP; cannot `gh pr close` via GraphQL integration

## Terminology

- **Stale PR** — open >24h, or draft with green CI but unmerged
- **Superseded PR** — branch work already landed on `main`; merge would regress or duplicate
- **Superseded close** — close with `Superseded by #N` when the head is an ancestor of another open PR's head or already in `origin/main`; keep the branch, never force-push it
- **Merge commit** — the only merge style for agent PRs (`gh pr merge <n> --merge`); never squash, never rebase-merge

## HoBo repo patterns

- Draft proofs live under `src/draft/<kind>/<slug>`
- Each proof needs traceability row, design proof README, protobuf/CUE/Pact artifacts
- Pre-existing `main` failures (closure-builder path, docs:okf on 4 proof READMEs) are known; don't chase as blockers
