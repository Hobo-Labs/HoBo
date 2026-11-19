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
project registration and launcher prerequisites, then use the host's supported
discovery or reload mechanism. A server that answers a separate test client,
or a configuration file on disk, does not prove that this agent session can
call its tools. For linked worktrees, Codex may evaluate project trust against
the primary checkout; inspect the host's disabled-configuration reason instead
of assuming that trusting the worktree path is sufficient. The repository's
supported registrations and startup steps are in
[agent tooling](../../../docs/agent-tooling.md#hobo--hobos-own-mcp-server-this-repo).

When HoBo is connected, use its owner setup flow to establish or reuse the
owner's store session. Before the owner enters anything, verify that the host
and HoBo keep settings, identifiers, connection references, and credentials in
a private temporary session and exclude them from agent-visible calls, results,
traces, and diagnostics. Do not ask for these values in chat or put them in
commands or the repository. The owner's store choice is theirs alone.

If the host or HoBo cannot provide that private flow, report which capability
is missing. Continue safe implementation and verification authorized by the
task; do not substitute provider-specific manual setup or claim that the store
is connected. Once established, reuse the owner session for later HoBo
operations and verify the outcome without exposing its private settings.

For a deployment that also needs CI or CD identities, follow the
[HoBo deployment skill](../hobo-deploy/SKILL.md) after the initial connection.
