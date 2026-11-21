# hobo (Agent Plugins 1.0.0)

HoBo's [Agent Plugins](https://agent-plugins.org) 1.0.0 plugin: the HoBo MCP
server (`mcp.json`, `bin/hobo-mcp.mjs`) plus the portable **hobo-setup** and
**hobo-deploy** skills (`skills/`). Manifest and MCP wiring are gated by
`pnpm run agent-plugin:check` against the committed 1.0.0 schemas in
`tools/agent-plugins/schemas/1.0.0/` (pinned by `MANIFEST.sha256` with an exact
entry per schema file; not the gitignored `plugins/hobo/fixtures/` deploy output).

## Version

`plugin.json`'s `version` follows the repository's fixed alpha release train
(`version.json` + Nerdbank.GitVersioning): `0.0.0-alpha.<height>`. The gate
measures the height at the commit being reviewed — the PR branch tip
(`HEAD^2` of the `pull_request` / `merge_group` checkout; `GITHUB_HEAD_SHA`
counts only when it matches that tip). If `HEAD^2` cannot be resolved on a PR or
merge-group event, the gate refuses version measurement instead of trusting
`GITHUB_HEAD_SHA` alone — never at the synthetic merge ref, whose
base-branch commits would
inflate the height past the value the branch pinned. Locally, a staged
`plugin.json` raises the expected height by one to account for the commit that
has not been made yet. The gate rejects versions outside the fixed alpha train
and pins strictly older than the checked commit. Pull-request and merge-group
validation, including any checkout whose selected commit resolves to `HEAD^2`,
also rejects a pin newer than the train: these contexts require an exact height.
Outside PR validation, only the explicit one-height squash lag on `push` can
pass a stale pin (`alpha.N` when the train is `alpha.N+1`); ahead-of-train
pins are rejected everywhere. Non-PR runs add a report note with
`GITHUB_EVENT_NAME` and the commit ish they measured when the comparison is
not exact.
Version computation failures fail the gate. In CI (`CI`, `GITHUB_ACTIONS`, or
`TF_BUILD`), the gate exits non-zero when the release train cannot be computed
or `versionFromReleaseTrain` would be omitted; only an explicit
`HOBO_AGENT_PLUGIN_SKIP_RELEASE_TRAIN=1` outside CI skips the check. Turbo tasks
use `envMode: strict`; `turbo.json` passes enumerated GitHub Actions identity
variables (`GITHUB_ACTIONS`, `GITHUB_EVENT_NAME`, `GITHUB_HEAD_SHA`,
`GITHUB_RUN_ATTEMPT`, `GITHUB_RUN_ID`, `GITHUB_SHA`, and related refs — not
`GITHUB_TOKEN`), plus `TF_BUILD` and `CI`, through so nested package builds see
the same CI identity as `agent-plugin:check`.

## Build the MCP bundle

`bin/hobo-mcp.mjs` is a build output (gitignored) because the single-file
esbuild bundle of the composed HoBo server is tens of megabytes. From a HoBo
checkout:

```sh
pnpm install
pnpm exec turbo run build --filter=@hobo/hobo...
pnpm run agent-plugin:build
```

In CI, HoBo Fabric's isolated `agent-plugin-provenance` job builds the bundle
and publishes GitHub artifact provenance with pinned
`actions/attest-build-provenance`. It is the only job with `id-token: write` and
`attestations: write`; validation jobs have only read permissions and no OIDC
grant. The build writes no bearer token or local attestation record. The signed
subject is the sha256 of `bin/hobo-mcp.mjs`; copied `fixtures/deploy` is checked
separately for presence and secrets, not attestation bytes.

`agent-plugin:check` runs `gh attestation verify` against GitHub's current
attestation API with the HoBo repository, `.github/workflows/hobo-ci.yml` signer,
and `GITHUB_SHA` source digest pinned. It then requires the verified
certificate's run invocation to match `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT`. Missing, forged, stale, wrong-workflow, wrong-commit, and
wrong-attempt attestations fail closed. A legacy `.bundle-attestation.json` is
rejected rather than treated as provenance. `pnpm agent:check` selects
`agent-plugin:check` on affected plugin, skill, and MCP inputs, and
`agent-plugin:check` always rebuilds first so a stale on-disk bundle cannot
pass.

Any CI signal outside GitHub Actions fails the bundle check. With no `CI`,
`GITHUB_ACTIONS`, or `TF_BUILD` signal, the command is an explicit local-only,
non-CI path: it always rebuilds, reports that provenance is absent, and cannot
be reused as CI validation. The build deletes a legacy local attestation before
bundling so an old bearer-token record cannot survive beside new output.

The build bundles `packages/hobo/src/bin/hobo-mcp.ts` (esbuild resolves
through `@hobo/hobo`), copies `packages/hobo/fixtures/deploy` to
`fixtures/deploy` (the deploy providers read it relative to the bundle), and
leaves `typescript` and the native Bitwarden SDK resolvable from the
surrounding checkout rather than inlining them. Run the server with
`node bin/hobo-mcp.mjs` — the same stdio protocol as the repo-registered
launcher in `.mcp.json`.

`pnpm run agent-plugin:check` resolves the `mcp.json` entrypoint against the
plugin root, rejects a missing or undersized bundle in CI, and scans an
existing bundle for secret-shaped values without echoing them. Reserved
Node execution env keys (`NODE_OPTIONS`, `NODE_TLS_REJECT_UNAUTHORIZED`,
`NODE_EXTRA_CA_CERTS`, `NODE_PATH`, and related injection keys) are rejected in
`mcp.json` server `env` maps.

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
checkout. The hand-off eval calls `auditHandOff` with
`DEFAULT_HAND_OFF_AUDIT_OPTIONS` from `@hobo/hobo-ci` (strict owner-form
defaults; no CLI flags that could spoof those options).

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
