### hobo — HoBo's own MCP server (this repo)

Source: extracted from the HoBo repository's `docs/agent-tooling.md`, section "hobo — HoBo's own MCP server (this repo)"; re-extract when that section changes. Commands marked **repo-only** need the HoBo repository checkout.

After the canonical text below changes, re-extract
`hobo-setup/references/agent-tooling.md` in the repo skill mirrors and portable
plugin so `agent-plugin:check` stays green.

`.mcp.json`, `.codex/config.toml`, and `.cursor/mcp.json` register the server from source without keys. The host must start the launcher within its intended trusted HoBo checkout: the launcher cannot identify which sibling checkout the host trusted. The Codex and Cursor launchers resolve that Git worktree root and refuse an ambiguous nested Git checkout. For a HoBo checkout nested inside another repository, configure the host to run `node --import tsx packages/hobo/src/bin/hobo-mcp.ts` with its working directory set to the HoBo checkout's absolute root. Install the workspace dependencies and run `pnpm exec turbo run build --filter=@hobo/hobo...` before starting an agent session in a fresh checkout; the source launcher imports built workspace packages. Codex loads the project configuration in a trusted project when the session starts. Registration alone does not establish that the host supports a private owner form. The server exposes the CLI verbs and secret capture used by the **hobo-deploy** skill. `pnpm run eval:hand-off-transcript <transcript.jsonl>` audits an agent transcript without printing owner settings; it accepts transcript paths only and rejects operator flags that would weaken the audit.

`plugins/hobo/` is the portable Agent Plugins v1.0.0 plugin, not the monorepo checkout root. In a HoBo checkout, `pnpm run agent-plugin:build` bundles the MCP server with esbuild into the gitignored `plugins/hobo/bin/hobo-mcp.mjs`; outside GitHub Actions it requires `HOBO_AGENT_PLUGIN_LOCAL_BUILD=1`, a clean working tree (including untracked files outside gitignore), and a matching reviewed commit for non-publishing PR builds. `pnpm run agent-plugin:check` requires `HOBO_AGENT_PLUGIN_LOCAL_CHECK=1` outside CI, checks plugin conformance, skill sync, applies `@hobo/agent-skills` strict frontmatter rules to repo-owned skills (every `.agents/skills` directory with a `SKILL.md` that is not listed in `skills-lock.json`), and drifts against this `agent-tooling.md` extract (mirrored under `hobo-setup/references/agent-tooling.md` in the repo skill, Claude mirror, and portable plugin). On `refs/heads/main`, checks require the per-job `GITHUB_TOKEN` for the verification step and `pnpm run agent-plugin:check -- --verify-attestation`; attestation verification pins repository, workflow, ref, and GitHub OIDC issuer identity, and PR and merge-group bundles are marked non-publishing and never accepted as main provenance. CI validates the plugin in dedicated steps: PR and merge-group jobs run `agent-plugin:build` and unflagged `agent-plugin:check`, while main's `agent-plugin-provenance` job publishes bundle provenance and `main-gate`'s attestation step runs `agent-plugin:build` and `agent-plugin:check -- --verify-attestation` with the GitHub Actions job `GITHUB_TOKEN`; `check:all` and `verify:full` do not run the plugin check. Main-gate sparse checkout includes `plugins` so the main-gate checks can read plugin sources. See `plugins/hobo/README.md` for the plugin layout and usage.

Use the [HoBo setup skill](../SKILL.md) to connect the
server and establish an owner-store session independently of a deployment.
The initial MCP handshake describes this separation; it does not itself
authenticate a store. For a linked worktree, Codex may check trust against the
primary checkout; its effective-configuration diagnostics identify a disabled
project layer and the checkout whose trust it requires.

If the active host has no HoBo tools, try its supported discovery or reload,
then diagnose the server independently. From the checkout root, the following
isolated test initializes HoBo and lists tools using the Cursor-registered
launcher and synthetic temporary state:

```sh
pnpm --filter @hobo/hobo exec vitest run test/mcp-cold-start.test.ts -t 'serves MCP through the registered launcher from a nested directory'
```

This checks that launcher with synthetic state; it does not verify the active
host's registration or actual environment, or an owner session. A separate MCP
client may also perform authorized non-sensitive work when the host cannot
attach the server. Report which client worked and which connection or private
session step remains unverified; do not infer the cause of a missing host tool
without evidence.

Connecting an agent includes connecting the owner's secret store: call
**`choose_secret_store`** with the target project directory as `cwd` (no store
settings in its arguments). It reuses an established owner store session, or
asks the owner privately: through MCP form elicitation (a store picker, then
only that store's non-secret IDs) when the host declares
`capabilities.elicitation` form mode, or through HoBo's store picker widget
(`ui://hobo/store-choice`, whose app-only `submit_store_choice` the model does
not call) when the host renders MCP Apps. A host with neither (a Claude Code
cloud session) gets `owner-page`: HoBo's own page, which the agent publishes as
a claude.ai Artifact with the `db` capability so it renders in the session.
The owner's answer, including the store's sign-in, is encrypted in their
browser to a one-use key only the HoBo server holds; the agent reads the sealed
text from the artifact's database and passes it unchanged to
`submit_owner_page`, and never sees the values. The choice is written to the
owner's locator outside the repository
(`~/.config/hobo/projects/<project>-<hash>/secret-store.json`), and HoBo then
signs in through the owner channel (the sign-in link inside a host form, the
Infisical session, 1Password or Bitwarden hand-offs) and keeps the store's
sign-in in the server's memory. The sign-in completes inside the call on a
remote box whose host shows form elicitation; elsewhere the result is
`sign-in-needed`. Every result the agent sees carries only a
status (`established`, `sign-in-needed` with a code, `shown`, `owner-page`,
`decline`, `invalid`, `refused`, `secure-form-unavailable`) and the store's name, never project or
vault IDs, hosts, or references. Once established, `store_owner_entries` asks the owner, in one private host form per entry, for the Hostinger entries and HoBo CI relay credential HoBo needs (`HOSTINGER_API_TOKEN`, `HOSTINGER_ARC_KUBECONFIG` as one base64 line, `HOBO_CI_ACCOUNT_TOKEN`) and writes each straight into the connected store; it keeps entries already there unless `replace: true`, and returns entry names only. Once established, `hobo deploy` resolves
credential locators `owner://<NAME>` (`env://<NAME>` is refused) from that session's CD location (Infisical folder `/hobo-cd`), so provider resolvers such as Hostinger's get
`HOSTINGER_API_TOKEN` from the owner's store without the value reaching the
agent; `hobo ci fleet status|restart|start` (the `ci` tool with
`args: ["fleet", ...]`) reads the same `owner://HOSTINGER_API_TOKEN` to list and
power-cycle the CI fleet's Hostinger VPS, or, for an Infisical store without
that entry, calls Hostinger through Infisical Agent Vault: HoBo runs the
`infisical agent-vault proxy` itself on loopback for the owner's one Agent
Vault project whose `http` service covers `developers.hostinger.com` (the
signed-in identity must be an Agent Vault admin there or hold an access
bundle with the service), so the token stays in Agent Vault; it refuses with
`HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE` until one of the two is in place, and
with `HOBO_AGENT_VAULT_PROJECT_AMBIGUOUS` when the identity reaches several
Agent Vault projects;
`hobo ci fleet caches --plan|--apply|--status` (`args: ["fleet", "caches", ...]`)
reads the ARC cluster's kubeconfig as `owner://HOSTINGER_ARC_KUBECONFIG` the
same way to mount and prewarm the scale sets' node pnpm store and image cache;
`doctor` reports `ownerStoreSession` as `established` and the store's
name only. Re-run `choose_secret_store` with `reselect: true` to choose a
different store.
When a handed-off `hobo ci up` or `hobo cd up` needs the store's own sign-in
(an Infisical access token, a 1Password Connect token, or Bitwarden's
personal API key), the `ci` or `cd` tool opens HoBo's secret capture form, or
refuses with a `HOBO_OWNER_CAPTURE name=<NAME> guide=<url>` line for the agent
to answer with `capture_secret`. The value goes to the waiting run in the
server's memory only. A shell run has no owner channel and names the HoBo MCP
route instead. Agents never use `request_credential` or another credential
store of their own: the repository's pre-tool hook denies it and
`eval:hand-off-transcript` reports it as `agent-stored-credential`.
Treat a status outside that vocabulary, an error, or a missing tool as a
stop condition. Before opening any owner form for store selection, capture, or
the lifecycle itself, apply the hobo-deploy skill's owner-channel privacy
verification. If that fails, do not open the form; report the missing secure
hand-off. A rendered form alone does not establish privacy.
The relay's existing capture adapter reads a separately configured Infisical
binding; a generic owner-store session is not yet wired to that adapter.
Its `connected` status indicates that the binding was read; it does not verify
owner authentication. `writable` reflects an active writer session. The
adapter accepts a writer identifier in tool arguments and returns store
references, so it is not the private owner setup described by the setup skill.

