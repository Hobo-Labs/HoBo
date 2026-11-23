---
name: hobo-setup
description: Connect HoBo MCP and establish a private owner secret-store session for any HoBo operation.
---

# Connecting HoBo

Start with HoBo MCP when the owner asks to connect HoBo or an operation needs
an owner store. This setup is independent of deployment. The agent must not
choose or create a store for the owner, or start CI or CD solely to obtain a
generic connection.

Check that the active host exposes HoBo MCP tools. If it does not, inspect the
project registration and launcher prerequisites, then try the host's supported
discovery or reload mechanism. For linked worktrees, Codex may evaluate project
trust against the primary checkout; inspect the host's disabled-configuration
reason instead of assuming that trusting the worktree path is sufficient.

If native tools are absent or startup needs diagnosis, initialize HoBo and list
its tools through a separate MCP client. The repository's isolated cold-start
test does this with the Cursor-registered launcher and temporary synthetic
state:

```sh
pnpm --filter @hobo/hobo exec vitest run test/mcp-cold-start.test.ts -t 'serves MCP through the registered launcher from a nested directory'
```

The test does not exercise the Codex registration, the active host's actual
environment, or an owner session. Check the intended host's launcher
separately if it differs. When a separate client is usable, use it for
permitted non-sensitive operations when practical; do not wait for native tool
registration to do work it can safely perform. A separate client or a
configuration file does not establish that this agent host has attached the
server. Never route owner settings or credentials through agent-visible calls
or client output.

Report independent server startup, active-host attachment, and authenticated
owner session as separate observations. Give a cause only when the evidence
supports it; for example, a missing host tool alone does not establish a trust
failure. The repository's supported registrations and startup steps are in
[agent tooling](../../../docs/agent-tooling.md#hobo--hobos-own-mcp-server-this-repo).

When HoBo is connected, connect the owner's store as part of that connection:
call HoBo's `choose_secret_store` with the project directory as `cwd` and no
store settings or credentials in its arguments. It reuses an established owner
store session, or asks the owner directly through a host-rendered form (MCP
form elicitation) or HoBo's store picker widget (MCP Apps). Where the host
shows neither, or answers HoBo's form with cancel or decline faster than a
person could (within 1.5 seconds), HoBo issues a one-time private link on the
project's HoBo CI relay instead. The owner's answers go to HoBo, are saved in
their own HoBo settings outside the repository, and HoBo signs in to the store
with what they gave. Its results carry only a status, the store's name, and
for status `link` the URL to show the owner. The owner's store choice is
theirs alone.
Do not ask for store settings, identifiers, or credentials in chat or put them
in commands or the repository.
Agents never store secrets: no environment variables holding credentials or
store settings, no `.env` or other local secret files, no GitHub Actions
secrets or variables, no credential stores of their own, and no
`request_credential` (it stores a key in the cloud environment, outside HoBo).
When a run needs the store's own sign-in (an Infisical access token, a
1Password Connect token, or a Bitwarden personal API key), HoBo asks the owner
for it with its own secret capture: the lifecycle tool's form, or
`capture_secret` for each `HOBO_OWNER_CAPTURE` line it returns. The value goes
to the waiting run in memory only.
Credentials are `owner://<NAME>` entries in the store the owner connects
through `choose_secret_store`; HoBo refuses `env://<NAME>` locators. This is
the [repository rule](../../../AGENTS.md#repository-rules-for-every-agent)
and admits no exceptions.

- `established`: the session is ready. HoBo verbs read the provider
  credentials they need (for example `owner://HOSTINGER_API_TOKEN`) from it;
  values never reach you. `doctor` reports `ownerStoreSession`. For example,
  the `ci` tool with `args: ["fleet", "status"]` lists the CI fleet's
  Hostinger VPS, and `["fleet", "restart", "<vm>"]` or
  `["fleet", "start", "<vm>"]` repairs one the account owns, and
  `["fleet", "caches", "--status"]` (or `--plan`, or
  `--apply --prewarm <sha>`) checks or mounts the ARC scale sets' node caches
  with the cluster kubeconfig `owner://HOSTINGER_ARC_KUBECONFIG`; never run
  kubectl for it. On `HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE`, call
  `choose_secret_store` first.
- `sign-in-needed` (with a code): the choice is kept; call
  `choose_secret_store` again when the owner is ready. Do not claim the store
  is connected.
- `shown`: HoBo's widget is with the owner; it connects the store when they
  submit it.
- `link` (with `url`): show the owner the URL exactly as given and tell them
  to open it on any device. The page there asks them to choose Infisical,
  1Password or Bitwarden, enter that store's settings and sign in; their
  answer is encrypted in their browser for this HoBo process alone, and the
  link works once, for about ten minutes. Then call `choose_secret_store`
  again with the same `cwd`; it waits up to 30 seconds for their answer and
  returns `link` with `waiting: true` until it arrives. Never ask the owner
  for anything the page asks, and never open or submit the page yourself. A
  link that expired or was used is replaced by a new one on the next call.
- `decline` or `invalid`: nothing was recorded; ask again only when the owner
  wants to.
- `secure-form-unavailable`: this host has no working private form and the
  link could not be issued; its `reason` says why
  (`owner-link-relay-unconfigured`: no `HOBO_CI_RELAY_URL` and no
  `relayOrigin` in the project's `.hobo/ci.json`; `owner-link-relay-unreachable`;
  `owner-link-relay-not-ready`: the relay has no hand-off mailbox store;
  `owner-link-relay-refused`; `no-private-owner-form` where no link channel
  is wired). Report that this host cannot provide a secure HoBo owner
  hand-off, with that reason.

Pass `reselect: true` only when the owner wants a different store.

If the host or HoBo cannot provide that private flow, report which capability
is missing. Continue safe implementation and verification authorized by the
task; do not substitute provider-specific manual setup or claim that the store
is connected. Once established, reuse the owner session for later HoBo
operations and verify the outcome without exposing its private settings.

The existing relay capture adapter accepts a writer identifier in tool
arguments and returns store references. It does not establish the private
owner setup described here and must not be used as its substitute.

For a deployment that also needs CI or CD identities, follow the
[HoBo deployment skill](../hobo-deploy/SKILL.md) after the initial connection.
