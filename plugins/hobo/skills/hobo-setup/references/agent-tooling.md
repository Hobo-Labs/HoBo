### hobo — HoBo's own MCP server (this repo)

Source: extracted from the HoBo repository's `docs/agent-tooling.md`, section "hobo — HoBo's own MCP server (this repo)"; re-extract when that section changes. Commands marked **repo-only** need the HoBo repository checkout.

`.mcp.json`, `.codex/config.toml`, and `.cursor/mcp.json` register the server from source without keys. The host must start the launcher within its intended trusted HoBo checkout: the launcher cannot identify which sibling checkout the host trusted. The Codex and Cursor launchers resolve that Git worktree root and refuse an ambiguous nested Git checkout. For a HoBo checkout nested inside another repository, configure the host to run `node --import tsx packages/hobo/src/bin/hobo-mcp.ts` with its working directory set to the HoBo checkout's absolute root. Install the workspace dependencies and run `pnpm exec turbo run build --filter=@hobo/hobo...` before starting an agent session in a fresh checkout; the source launcher imports built workspace packages. Codex loads the project configuration in a trusted project when the session starts. Registration alone does not establish that the host supports a private owner form. The server exposes the CLI verbs and secret capture used by the **hobo-deploy** skill. `pnpm run eval:hand-off-transcript <transcript.jsonl>` (repo-only) audits an agent transcript without printing owner settings.

`plugins/hobo/` is the portable Agent Plugins v1.0.0 plugin, not the monorepo checkout root. In a HoBo checkout, `pnpm run agent-plugin:build` (repo-only) bundles the MCP server with esbuild into the gitignored `plugins/hobo/bin/hobo-mcp.mjs`; `pnpm run agent-plugin:check` (repo-only) always rebuilds first, then checks plugin conformance, skill sync, and drift in this `agent-tooling.md` extract. `check:all`, `verify:full`, and CI full-scope jobs run `agent-plugin:build` before `agent-plugin:check` as well. See `plugins/hobo/README.md` for the plugin layout and usage.

Use the [HoBo setup skill](../SKILL.md) to connect the
server and establish an owner-store session independently of a deployment.
The initial MCP handshake describes this separation; it does not itself
authenticate a store. For a linked worktree, Codex may check trust against the
primary checkout; its effective-configuration diagnostics identify a disabled
project layer and the checkout whose trust it requires.

If the active host has no HoBo tools, try its supported discovery or reload,
then diagnose the server independently. From the checkout root, the following
isolated test (repo-only: it lives in the HoBo repository) initializes HoBo
and lists tools using the Cursor-registered launcher and synthetic temporary
state:

```sh
pnpm --filter @hobo/hobo exec vitest run test/mcp-cold-start.test.ts -t 'serves MCP through the registered launcher from a nested directory'
```

This checks that launcher with synthetic state; it does not verify the active
host's registration or actual environment, or an owner session. A separate MCP
client may also perform authorized non-sensitive work when the host cannot
attach the server. Report which client worked and which connection or private
session step remains unverified; do not infer the cause of a missing host tool
without evidence.

Call **`choose_secret_store`** before store selection and proceed only when the
result documents a private owner ceremony the host can render. Treat
`secure-form-unavailable`, `owner-setup-unavailable`, unknown status, errors, or
a missing tool as stop conditions. Do not collect store identifiers in chat or
tool arguments. When a private hand-off is available, use the same target project
`cwd` throughout the ceremony; otherwise report the missing capability without
collecting settings.
The relay's existing capture adapter reads a separately configured Infisical
binding; a generic owner-store session is not yet wired to that adapter.
Its `connected` status indicates that the binding was read; it does not verify
owner authentication. `writable` reflects an active writer session. The
adapter accepts a writer identifier in tool arguments and returns store
references, so it is not the private owner setup described by the setup skill.
