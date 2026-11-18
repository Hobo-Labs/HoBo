---
name: gh-stack
description: >
  Manage stacked branches and pull requests with GitHub's official gh-stack CLI extension
  (github/gh-stack). Use for stacked diffs, dependent PRs, branch chains, cascading rebases,
  stack submit/sync/merge. Prefer non-interactive flags only. For full HoBo SDLC parent protocol
  (subagents, bottom-up review, squash-merge closeout) also load the sdlc skill.
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

## Non-interactive rules (never hang)

| Always | Never |
|---|---|
| `gh stack init <branches...>` | bare `gh stack init` |
| `gh stack add <branch>` | bare `gh stack add` |
| `gh stack submit --auto` (+ `--open` when ready) | `submit` without `--auto` |
| `gh stack view --json` | `view` / `view --short` |
| `gh stack checkout <pr\|url\|branch\|stack#>` | bare `checkout` |
| `gh stack merge <pr\|stack#> --yes --squash` | interactive merge / wrong bare `gh pr merge` on stacks |

If local vs remote stack compositions conflict on checkout: `gh stack unstack --local` then retry checkout.

## Quick commands

```bash
gh stack init sdlc/feat-01-schema
# commits on layer...
gh stack add sdlc/feat-02-impl
# commits...
gh stack submit --auto --open
gh stack view --json
gh stack sync
gh stack sync --prune
gh stack rebase --upstack          # after mid-stack fix
gh stack rebase --continue         # after resolving conflicts
gh stack merge 42 --yes --squash   # merge through PR #42
gh stack top | bottom | up | down | trunk
```

## Agent workflow snippets

**Create stack**

```bash
gh stack init layer-a
git add -p && git commit -m "feat(scope): layer a"
gh stack add layer-b
git add -p && git commit -m "feat(scope): layer b"
gh stack submit --auto --open
```

**Fix lower layer while on upper**

```bash
gh stack checkout layer-a
# fix + commit
gh stack rebase --upstack
gh stack push
gh stack top
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

In this repo, **parent agents** running the `sdlc` skill own stack topology, bottom-up
rubber-duck/adversarial review, comment resolution, status-check repair, and per-PR squash-merge.
**Subagents** only commit incrementally on their assigned layer branch. See:

- `.agents/skills/sdlc/SKILL.md`

Do not use interactive `gh stack modify` from agents; restructure via `unstack` + re-`init` with
explicit branch lists when needed.
