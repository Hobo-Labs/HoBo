---
name: hobo-deploy
description: Use HoBo's owner hand-off and secret-store session when deploying a HoBo service, including the hosted CI relay managed by HoBo CD.
license: MIT
compatibility: Agent Skills-compatible hosts (Claude Code, Cursor, Codex, and other skill hosts); the MCP server needs Node.js 22+ and a built plugin bundle (pnpm run agent-plugin:build in the HoBo checkout).
metadata:
  source: https://github.com/Hobo-Labs/HoBo
  plugin: hobo
---

# Deploying with HoBo

Use the [HoBo setup skill](../hobo-setup/SKILL.md) for the initial MCP connection
and owner-store session before starting a deployment-specific ceremony.

Use the HoBo CLI and its owner hand-off for provider connections. The owner
chooses an existing secret store; the run opens it through HoBo's common store
interface. Do not select a provider because a token happens to be available,
and do not create another store merely because this host cannot open the
owner's existing one.

Store coordinates, project and vault identifiers, connection references, and
secrets are private to the owner. Never request them in conversation, echo them
in a result, put them in a command, or add them to the repository. The owner
supplies any necessary information directly to a verified secure HoBo owner
form that keeps it in the temporary owner session. Existing owner settings may be
read from outside the repository without returning their contents to the agent.
Never inspect or quote a store reference. If this host cannot render the
secure HoBo owner hand-off, report that capability gap; do not ask the owner
to paste identifiers or values as a workaround.

Before opening any owner form, verify without using owner data that the
connected hand-off keeps selections in a temporary owner session and excludes
private coordinates, identifiers, and references from agent-visible tool calls,
results, traces, and diagnostics. This applies to store selection, capture, and
the lifecycle itself. If that cannot be established, do not open the form;
report the missing secure hand-off.

For the hosted relay, HoBo CD delivers the selected Git commit to Vercel;
the Vercel project does not need a connected Git repository. A managed deploy
uses the owner's existing CD connection. A headless runner must have an
authorized owner-store session or workload identity and owner-selected store
settings outside the repository. Report a missing session accurately.

## Set up missing identities through HoBo

Before treating a missing or unverified identity, store connection, or workload
session as a deployment blocker, run the relevant HoBo setup ceremony. Use
`hobo ci up --hand-off` for CI and `hobo cd up --hand-off` for CD; when a
deployment needs both, run both. Let the ceremony reuse existing connections,
set up or verify the identities it needs, and continue it through the owner
hand-off. A successful store-connection check alone does not establish that the
other family's identity or session is ready.

Do not replace the ceremony with instructions to create identities, tokens, or
stores by hand. If the ceremony needs the owner and this host cannot provide the
required secure hand-off, report that specific capability gap rather than
asking for identifiers or values. Do not claim setup completed until HoBo
reports completion.

## Running `hobo ci up` / `hobo cd up` for the owner

You are usually in a box the owner cannot reach (a remote managed session).
If the project HoBo MCP server is missing, check the project MCP registration
and its startup prerequisites before reporting it unavailable. In a fresh
checkout, install the workspace dependencies and run
`pnpm exec turbo run build --filter=@hobo/hobo...`; then use the host's
supported MCP discovery or reload mechanism. A successful build or a listed
server does not establish that a private owner form is available or safe.
Never give the owner a `127.0.0.1`/`localhost` link, a port to forward, or a
tunnel to set up: they cannot complete those. A handed-off run serves
nothing in the box and nothing calls back into it. A privacy-verified hand-off
must route each owner step through a private form and let the run pick up the
owner's response. Do not relay private fields from a raw progress line.

**When the host can render the required secure form, every owner-facing line
gets a structured ask, never a question in prose.** A choice goes to a picker
the host renders, a credential to the session's credential form. If an ask
does not complete (interrupted, the session restarted, the form closed),
issue it again as the first thing you do, before any other reply. Ending a
turn with a choice or credential still unasked is a failure when that form is
available; `pnpm run eval:hand-off-transcript <transcript>` (repo-only: it
runs from the HoBo checkout) checks it. If the
form is unavailable or fails the privacy check below, report that capability
gap; do not repeat an impossible ask or collect its fields in conversation.
Say "This host cannot provide a secure HoBo owner hand-off." when host
capability discovery confirms no private owner form.
`pnpm run eval:hand-off-transcript <transcript>` enforces structured asks with
default strict options; it accepts no operator flags that weaken that audit.
Verify the private owner channel as described above; a displayed form alone does not establish privacy.

1. Run `hobo <ci|cd> up --hand-off` through the **HoBo MCP server** (its
   `ci` or `cd` tool with `args: ["up", "--hand-off"]`) only when its
   owner channel has passed the privacy check above. Pass the target project
   directory as `cwd` to both the lifecycle tool and `choose_secret_store`;
   use the same `cwd` on every retry so the owner session stays scoped to that
   project. Run it again the same way after each owner step. If that
   channel is absent or unverified, stop at an owner step and report the
   missing secure hand-off. Do not run the lifecycle through a fallback
   channel or read its captured stdout/stderr.
2. On `HOBO_*_STORE_CHOICE` (the owner has not chosen a store): use the
   HoBo MCP server's **`choose_secret_store`** (`mcp__hobo__choose_secret_store`,
   `family` ci or cd) only when the connected implementation keeps the choice
   in the temporary owner session and excludes store coordinates from every
   agent-visible response. If that privacy cannot be established, report the
   missing secure hand-off and do not collect the choice's fields. A supported
   host shows the owner a picker of **Infisical**,
   **1Password** and **Bitwarden** and a secure owner form for its settings.
   The owner supplies the information directly to HoBo, never to the agent.
   If the host cannot render that form, or the HoBo server is not connected,
   report the missing secure hand-off instead of collecting identifiers in
   chat or command arguments. A host picker (`AskUserQuestion`) may ask for
   the store **alone**, one question; it cannot replace the secure form.
   After the form completes, run again. HoBo installs the store's CLI if
   needed and uses the owner's existing session or its secure sign-in flow.
   Never relay instructions to create identities or tokens by hand. The
   choice is always the owner's: never pick a store for them because its
   token is present. Never ask the owner to set environment variables, never
   send them to a terminal, and never ask them to create identities or
   tokens by hand. Ask nothing about the other stores.
3. On `HOBO_OWNER_CREDENTIAL`: the run is waiting for a credential. Use a
   privacy-verified owner form that presents any host, guide, and steps directly
   to the owner without returning them to the agent. For a username and password
   form, use `suggested_type: "basic"` when the host supports it. Once the owner
   saves it, the run continues by itself; do not rerun it. If that private form
   is unavailable, report the missing secure hand-off. Do not relay a host,
   guide, or raw steps from the progress line into chat.
4. **Through a privacy-verified HoBo MCP server, the run asks the owner itself.**
   A compatible `cd` (or `ci`) call must show every step as a
   form in the owner's host, its link inside it: Infisical's sign-in link
   with the paste field, then Vercel's approval link and code with a
   **Done** button. You call the lifecycle and wait; you never relay a
   link, a code or a step in chat, and you never call `capture_secret` for
   a value the run is waiting on. If the call ends with
   `HOBO_OWNER_SIGN_IN` or `HOBO_CD_VERCEL_AWAITING_APPROVAL` (the owner
   closed a form), run the lifecycle again: the same form comes back.
   A form unanswered for 10 minutes (`HOBO_OWNER_FORM_WAIT_MS`) is
   withdrawn and the call ends the same way, so it never hangs. If the owner
   cannot see a privacy-verified form, report that capability gap; do not
   relay a dynamic link or value through chat. Never ask for a value in chat,
   and never use `request_credential` for a value the lifecycle is waiting on
   (that form feeds the network proxy, not the run).
   On `HOBO_OWNER_CAPTURE`, when the lifecycle has returned and calls for a
   separate capture, use `capture_secret` once per requested name through a
   privacy-verified form. Its guide is shown directly to the owner; do not
   relay it through the agent. Run again when the captures are complete.
   A compatible `capture_secret` shows a privacy-verified form the host renders: HoBo's MCP
   App, or, where the host has none, the host's own elicitation form (its
   result's `hostSupport` says which). Tell the owner to use the form only
   when the result shows one (`channel` `mcp-app`, or `status: stored` from
   the elicitation form). On `SECRET_CAPTURE_NO_OWNER_FORM` (a remote box
   whose host shows neither), report that this host cannot collect the value;
   never send the owner to a page, a preview or the chat.
5. On `HOBO_OWNER_BITWARDEN_APPROVE` or `HOBO_*_BITWARDEN_ORGANIZATION`,
   the approval or organization choice must appear directly in a verified
   secure owner form. Never relay a private host, organization, or fingerprint
   phrase through chat. If the host cannot show the form, report the missing capability.
6. On `HOBO_OWNER_DEVICE` (cd), a verified secure owner form must present the approval
   link and code so the owner can approve from any device. The run completes
   the grant itself. If the host cannot show that form, report the missing
   secure hand-off instead of relaying dynamic fields.
7. When the run ends, report completion or its refusal code and applicable
   remediation, excluding any private coordinates or references. Never repeat
   private information from a diagnostic.

**Creating the GitHub App for the owner.** Continue `hobo ci up --hand-off`
through a privacy-verified HoBo MCP owner hand-off so the owner can approve the App and supply
any one-time code directly to the run. The standalone app-creation command is
not a substitute unless it supports this private owner channel. Never ask the
owner to send a code or an identifier to the agent, and never transfer one
through chat, command arguments, stdin, or a file. If the host cannot render
the secure hand-off, report that capability gap. Never point the owner at the
relay or any shared service for the App's code.

For a new GitHub App, the run may report `HOBO_CI_APP_NEEDS_OWNER` and
`HOBO_OWNER_SIGN_IN` with a `GITHUB_APP_CODE` capture. The one-time code must
stay in the privacy-verified owner channel. If the implementation cannot do
that, report the missing secure hand-off. Never route the code through a relay
or any shared service.

**At the owner's own terminal** (no `--hand-off`), the run opens its local
setup page (`HOBO_OWNER_PAGE`) in their browser. That page is for their own
machine only, never a remote box.

Never fetch or submit a page, approve a code, or read a secret yourself.
Secret variables in the agent's environment are ignored on purpose.

## Reporting

Report the deployment outcome and verified checks. State any missing secure
owner hand-off or workload session. Never report store coordinates, project
or vault identifiers, connection references, tokens, or captured values.
