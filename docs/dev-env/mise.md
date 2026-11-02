# mise dev environment (HoBo)

HoBo provisions **project** tool versions from the repo-root [`mise.toml`](../../mise.toml) and [`mise.lock`](../../mise.lock). Personal shell, editor, and agent preferences live in the separate **[Hobo-Labs/dotfiles](https://github.com/Hobo-Labs/dotfiles)** repository (seed bundle under [`contrib/hobo-dotfiles-seed/`](../../contrib/hobo-dotfiles-seed/) until the org repo is published). Cloud agents and devcontainers call [`scripts/bootstrap-dev.sh`](../../scripts/bootstrap-dev.sh), which installs mise, applies dotfiles, and runs `mise install`.

## Why mise

mise replaces ad hoc **Corepack-only** Node/pnpm setup, **cue-lang/setup-cue**, curl/brew/cargo installers in [`scripts/setup-agent-tools.sh`](../../scripts/setup-agent-tools.sh), and any parallel version managers (asdf, nvm, volta). One manifest drives local shells, editors, CI (via [jdx/mise-action](https://github.com/jdx/mise-action)), devcontainers, and Cursor Cloud images. **pnpm** remains the JavaScript dependency manager; mise only installs the `pnpm` CLI version pinned in `packageManager`.

## `mise.toml` in this repo

| Section | HoBo usage |
| --- | --- |
| `[tools]` | `node@24`, `pnpm@10.33.4` (matches `package.json#packageManager`), `cue@0.14.0` (schema lane), `turbo@2.11.10` (matches root devDependency). |
| `[env]` | Optional project env vars (keep secrets out; use `mise env` + `.env` locally). |
| `[tasks]` | Thin wrappers around existing `pnpm` / Turbo scripts so `mise run build` matches `pnpm run build`. |
| `[settings]` | `experimental = true` only when needed; prefer stable flags. |

Commit **both** `mise.toml` and `mise.lock`. CI and agents run `mise install` (not `mise install --lock` alone without the lockfile).

## Lockfile (`mise.lock`)

`mise lock` records per-platform checksums and download URLs for each pinned tool (lockfile version 3 in current mise). Properties:

- **Reproducibility** — same bytes on Linux/macOS/Windows CI and devcontainers.
- **Reviewability** — version bumps show up as lockfile diffs alongside `mise.toml`.
- **Offline / airgap** — after one online `mise install`, tools live under `~/.local/share/mise` (or `MISE_DATA_DIR`). With no network, mise uses the cache; pre-seed the cache or vendor tarballs for fully offline lanes. Lockfile URLs are still required for cold installs.
- **Regenerate** — after editing `[tools]`, run `mise lock` and commit.

## Backends (how tools resolve)

mise picks a backend per tool name:

| Backend | Examples in HoBo |
| --- | --- |
| **aqua** | `cue` → `cue-lang/cue` releases |
| **node** (core) | `node`, `pnpm` |
| **ubi** / **github** | CLIs distributed as single binaries (dotfiles repo pins `tgrep`, `rtk`, etc.) |
| **npm** / **cargo** / **go** | Available for agent tools; prefer aqua/ubi when a release asset exists |

HoBo root keeps the **minimal** set required to build and run gates. Optional agent binaries move to dotfiles’ `mise.toml`.

## Trust model

mise refuses to run untrusted config:

- **`mise trust`** — marks a `mise.toml` path as trusted (per user).
- **`MISE_TRUSTED_CONFIG_PATHS`** — colon-separated allowlist (CI/devcontainer).
- **`mise settings set trusted_config_paths`** — persistent trust.

HoBo CI sets trust via mise-action (`install: true` trusts the checkout). Devcontainers run `mise trust -a` or trust the workspace file in `bootstrap-dev.sh`.

## `mise activate` vs shims

| Mode | When |
| --- | --- |
| **`eval "$(mise activate bash\|zsh\|fish)"`** | Interactive shells and devcontainer `postCreateCommand`; PATH and env update when `cd` changes. |
| **Shims** (`~/.local/share/mise/shims`) | Editors, hooks, and scripts that do not load shell rc files. |
| **`mise exec -- …`** | One-shot commands (CI steps, `mise run` tasks). |

HoBo uses **activate** in bootstrap scripts and **mise exec** in CI workflows for explicit, log-friendly steps.

## Caching

- **Tool cache** — `MISE_DATA_DIR` / `~/.local/share/mise` stores extracted installs; safe to mount in devcontainer features.
- **mise-action `cache: true`** — restores GitHub Actions cache for mise data keyed by lockfile hash.
- **Turbo / pnpm** — unchanged; still use Turbo remote cache and `actions/cache` or [`.github/actions/turbo-cache`](../../.github/actions/turbo-cache) where enabled.

## CI (GitHub Actions)

Use the SHA-pinned action (update the pin when bumping):

```yaml
- uses: jdx/mise-action@8008c3f4db491fde6fd6d72dc97fbdb752dac949
  with:
    install: true
    cache: true
    experimental: false
```

Then run `pnpm run install:check` and Turbo tasks. **Remove** redundant `actions/setup-node`, `corepack enable`, and `cue-lang/setup-cue` when those tools are in `mise.toml`.

HoBo’s full fabric workflow (`.github/workflows-disabled/hobo-ci.yml` and the restored `hobo` runner variant) follows this pattern. Runner availability may be blocked independently (see PR #1631).

## Devcontainer

- **Image** — install mise via `https://mise.run` in [`.devcontainer/Dockerfile`](../../.devcontainer/Dockerfile) (or the [devcontainers-extra mise feature](https://github.com/devcontainers-extra/features/tree/main/src/mise)).
- **postCreate** — [`scripts/bootstrap-dev.sh`](../../scripts/bootstrap-dev.sh) then `pnpm install` and agent common layer.
- **Dotfiles** — point `dotfiles.repository` at `Hobo-Labs/dotfiles` when published, or rely on `bootstrap-dev.sh` cloning the seed URL.

## Cursor Cloud / Codex / Claude remote

Agents without a custom Dockerfile run:

```bash
bash scripts/bootstrap-dev.sh
pnpm run install:check
```

Documented in [AGENTS.md](../../AGENTS.md) and [CLAUDE.md](../../CLAUDE.md). No sudo required; mise installs to `~/.local/bin`.

## Hermetic CI runner (`mise oci`)

Self-hosted **`runs-on: hobo`** jobs use a container built from this repo’s **`mise.toml` / `mise.lock`**, not workflow tool installers:

- **Base image only in Docker** — [`packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile`](../../packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile): digest-pinned Debian, [`system-packages.txt`](../../packages/ci-gh-actions/deploy/ci-runner/system-packages.txt), Docker CLI, UID **1000**, pinned GitHub Actions runner bundle.
- **Tool layers** — `[oci]` in [`mise.toml`](../../mise.toml); build with **`MISE_EXPERIMENTAL=1`** and pinned mise ([`mise-version.txt`](../../packages/ci-gh-actions/deploy/ci-runner/mise-version.txt)) on **native Linux** (arm64 or x64, no cross-build).
- **Operator command** — `bash packages/ci-gh-actions/deploy/ci-runner/build.sh` (see [`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md)).

Preflight: `node --no-warnings scripts/ci-runner-preflight.mts` (Node 24 native TS; no `pnpm install` / tsx required before CI steps). Fallback monolithic Dockerfile: [`deploy/ci-runner/README.md`](../../packages/ci-gh-actions/deploy/ci-runner/README.md).

## Tasks vs package.json scripts

`[tasks]` in `mise.toml` delegate to existing npm scripts so muscle memory stays (`pnpm run test:unit`). Prefer adding behavior once in `package.json` and wrapping with `mise run` for discoverability (`mise tasks`).

## Related commands

```bash
mise install          # install tools from mise.toml + lockfile
mise doctor           # verify activate + data dir
mise run build        # run a defined task
mise exec node@24 -- node -v
bash scripts/bootstrap-dev.sh
```

## References

- [mise documentation](https://mise.jdx.dev/)
- [mise lockfile](https://mise.jdx.dev/dev-tools/mise-lock.html)
- [mise-action](https://github.com/jdx/mise-action)
- [mise bootstrap / dotfiles](https://mise.jdx.dev/mise/bootstrap.html)
