---
name: gh-stack
description: "Manage stacked branches and pull requests with GitHub's official gh-stack CLI extension (github/gh-stack). Use for stacked diffs, dependent PRs, branch chains, cascading rebases, local stack sync. Prefer non-interactive flags only. In HoBo a stack lands as one unit: one PR for the top layer, merged with a merge commit (never squash or rebase-merge). For the full SDLC parent protocol (subagents, combined-diff review, closeout) also load the sdlc skill."
metadata:
  author: github + hobo
  version: "0.1.0"
---

# gh-stack (agent CLI)

Official extension: https://github.com/github/gh-stack · Docs: https://gh.io/stacks

```bash
gh extension install github/gh-stack
# or upgrade: gh extension upgrade stack
```

Repo setup also installs it via `scripts/setup-agent-tools.sh` (common layer) and sets:

```bash
git config --local rerere.enabled true
git config --local remote.pushDefault origin
```

## Model

```text
main (trunk)
 └── bottom-layer   → PR base: main
  └── mid-layer     → PR base: bottom-layer
   └── top-layer    → PR base: mid-layer
```

Bottom = closest to trunk. `up` moves away from trunk; `down` toward it.

In HoBo, layers organize commits and checkins; the stack lands as **one unit**. Open one PR for
the top layer against `main`, review and validate its combined diff locally while it is a draft,
then mark it ready for GitHub Actions and land it with a merge commit only after checks pass. Lower layers are then merged automatically because their
commits are in `main`. Do not open a PR per layer.

## Non-interactive rules (never hang)

| Always | Never |
|---|---|
| `gh stack init <branches...>` | bare `gh stack init` |
| `gh stack add <branch>` | bare `gh stack add` |
| `gh pr create --base main --head <top-branch>` | `gh stack submit` (opens a PR per layer) |
| `gh stack view --json` | `view` / `view --short` |
| `gh stack checkout <pr\|url\|branch\|stack#>` | bare `checkout` |
| `gh pr merge <top-pr> --merge` | `--squash` / `--rebase` / merging layers one at a time |
| `git merge origin/main` on pushed layers | `gh stack rebase` / `gh stack sync` on pushed layers, force-push |

If local vs remote stack compositions conflict on checkout: `gh stack unstack --local` then retry checkout.

## Quick commands

```bash
gh stack init sdlc/feat-01-schema
# commits on layer...
gh stack add sdlc/feat-02-impl
# commits...
gh stack view --json
gh stack sync                      # unpushed local layers only
gh stack rebase --upstack          # after mid-stack fix, unpushed layers only
gh stack rebase --continue         # after resolving conflicts
git merge origin/main              # update a pushed layer with trunk
gh pr create --base main --head sdlc/feat-02-impl   # one PR: the top of the stack
gh pr merge 42 --merge             # land the whole stack through top PR #42
gh stack top | bottom | up | down | trunk
```

## Agent workflow snippets

**Create stack**

```bash
gh stack init layer-a
git add -p && git commit -m "feat(scope): layer a"
gh stack add layer-b
git add -p && git commit -m "feat(scope): layer b"
git push -u origin layer-a layer-b
gh pr create --base main --head layer-b --title "feat(scope): …" --body "…"
```

**Fix lower layer while on upper**

```bash
gh stack checkout layer-a
# fix + commit
gh stack top
git merge layer-a                  # pushed layers: merge the fix up
# unpushed layers only: gh stack rebase --upstack
git push
```

**Parse status**

```bash
gh stack view --json | jq -r '.branches[] | "\(.name) \(.pr.number // "-") \(.pr.state // "none") merged=\(.isMerged)"'
```

## Exit codes

| Code | Meaning | Action |
|---|---|---|
| 0 | ok | continue |
| 2 | not in a stack | `init` / `checkout` first |
| 3 | rebase conflict | resolve, `git add`, `rebase --continue` or `--abort` |
| 6 | branch in multiple stacks | checkout non-shared branch |
| 9 | stacks not enabled on repo | stop; tell user |
| 4 | GitHub API | check `gh auth status` |

## HoBo integration

In this repo, **parent agents** running the `sdlc` skill own stack topology, the one workstream
PR, combined-diff rubber-duck/adversarial review, comment resolution, status-check repair, and
the merge-commit landing of the top PR.
**Subagents** only commit incrementally on their assigned layer branch. See:

- `.agents/skills/sdlc/SKILL.md`

Do not use interactive `gh stack modify` from agents; restructure via `unstack` + re-`init` with
explicit branch lists when needed.
