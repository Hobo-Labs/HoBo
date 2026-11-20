# hobo (Agent Plugins 1.0.0)

HoBo's [Agent Plugins](https://agent-plugins.org) 1.0.0 plugin: the HoBo MCP
server (`mcp.json`, `bin/hobo-mcp.mjs`) plus the portable **hobo-setup** and
**hobo-deploy** skills (`skills/`). Manifest and MCP wiring are gated by
`pnpm run agent-plugin:check` against the vendored 1.0.0 schemas in
`tools/agent-plugins/schemas/1.0.0/`.

## Version

`plugin.json`'s `version` follows the repository's fixed alpha release train
(`version.json` + Nerdbank.GitVersioning): `0.0.0-alpha.<height>`. The gate
measures the height at the commit being reviewed — the PR branch tip
(`GITHUB_HEAD_SHA`, else `HEAD^2` of the `pull_request` / `merge_group`
checkout) — never at the synthetic merge ref, whose base-branch commits would
inflate the height past the value the branch pinned. Locally, a staged
`plugin.json` raises the expected height by one to account for the commit that
has not been made yet. The gate rejects versions outside the fixed alpha train
and pins strictly older than the checked commit. Pull-request and merge-group
validation, including any checkout whose selected commit resolves to `HEAD^2`,
also rejects a pin newer than the train: these contexts require an exact height.
Outside PR validation, a higher alpha height survives because a squash merge on
`main` can sit at a lower height than the branch tip the pin was synced to;
those runs add a report note carrying `GITHUB_EVENT_NAME` and the commit ish
they measured, so a non-exact comparison is visible instead of silent.
Version computation failures fail the gate; only an explicit
`HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN=1` outside CI skips the check.

## Build the MCP bundle

`bin/hobo-mcp.mjs` is a build output (gitignored) because the single-file
esbuild bundle of the composed HoBo server is tens of megabytes. From a HoBo
checkout:

```sh
pnpm install
pnpm exec turbo run build --filter=@hobo/hobo...
pnpm run agent-plugin:build
```

The build bundles `packages/hobo/src/bin/hobo-mcp.ts` (esbuild resolves
through `@hobo/hobo`), copies `packages/hobo/fixtures/deploy` to
`fixtures/deploy` (the deploy providers read it relative to the bundle), and
leaves `typescript` and the native Bitwarden SDK resolvable from the
surrounding checkout rather than inlining them. Run the server with
`node bin/hobo-mcp.mjs` — the same stdio protocol as the repo-registered
launcher in `.mcp.json`.

`pnpm run agent-plugin:check` resolves the `mcp.json` entrypoint against the
plugin root, rejects a missing or undersized bundle in CI, and scans an
existing bundle for secret-shaped values without echoing them.

The native `@bitwarden/sdk-napi` binding cannot be carried by a portable
bundle. Inside a HoBo checkout with installed dependencies it resolves
through the workspace; elsewhere, Bitwarden store operations report how to
make the package available, and every pure-JavaScript path (Infisical and
1Password ceremonies included) keeps working.

## Skills

`skills/hobo-setup` and `skills/hobo-deploy` are the portable copies of the
repo-local skills of the same names (`.agents/skills/` and `.claude/skills/`).
`pnpm run agent-plugin:check` fails if their name, description, or body drift
from the repo copies. It enumerates every shipped file recursively, rejects any
plugin file with no mirrored `.agents/skills` source (only `SKILL.md` may extend
the frontmatter), and scans every shipped text file for secret-shaped values.
Diagnostics identify the file and failure without reproducing rejected path or
frontmatter values. Commands marked **repo-only** in those skills (the MCP
cold-start test, `eval:hand-off-transcript`) exist only inside a HoBo
checkout.

`skills/hobo-setup/references/agent-tooling.md` is an extract of the `hobo`
MCP-server section in `docs/agent-tooling.md`. The same gate fails when that
section changes without re-extracting the reference: docs links into
`.agents/skills/hobo-setup/` must be rewritten plugin-relative (for example
`../SKILL.md`), and the intentional **repo-only** markers plus the leading
`Source:` note are preserved.

## Hooks

HoBo ships no product hooks. Future client hooks land under
`plugins/hobo/<reverse-domain>/hooks/` per the Agent Plugins specification,
one directory per extension namespace, and stay out of the repository's own
hook configuration (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml` are
repo registration, not plugin surfaces).
