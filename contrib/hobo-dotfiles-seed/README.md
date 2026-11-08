# Hobo-Labs dotfiles (seed)

This directory is the **initial content** for [Hobo-Labs/dotfiles](https://github.com/Hobo-Labs/dotfiles). The cloud agent token could not create the org repository; after merge, push this tree to a new `Hobo-Labs/dotfiles` repo (or `Tyler-R-Kendrick/dotfiles` if org creation is blocked):

```bash
cd contrib/hobo-dotfiles-seed
git init
git add .
git commit -m "chore: initial HoBo dotfiles (mise, shell, agent prefs)"
gh repo create Hobo-Labs/dotfiles --public --source=. --remote=origin --push
```

HoBo clones it from `scripts/bootstrap-dev.sh` via `HOBO_DOTFILES_REPO`.

## What lives here vs HoBo

| Location | Contents |
| --- | --- |
| **dotfiles** | Shell hooks, git identity helpers, Grok subscription auth helper, optional agent CLIs (tgrep, rtk, uv), mise user tools |
| **HoBo repo** | `mise.toml` / `mise.lock`, lint configs, `.mcp.json`, `.claude/settings.json`, project MCP, `AGENTS.md` |

## Install

```bash
./install.sh
```

Idempotent: safe on every devcontainer postCreate and cloud agent boot.
