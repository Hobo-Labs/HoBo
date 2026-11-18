---
name: hobo-deploy
description: Use HoBo's owner hand-off and secret-store session when deploying a HoBo service, including the hosted CI relay managed by HoBo CD.
---

# Deploying with HoBo

Use the HoBo CLI and its owner hand-off for provider connections. The owner
chooses an existing secret store; the run opens it through HoBo's common store
interface. Do not select a provider because a token happens to be available,
and do not create another store merely because this host cannot open the
owner's existing one.

Store coordinates, project and vault identifiers, connection references, and
secrets are private to the owner. Never request them in conversation, echo them
in a result, put them in a command, or add them to the repository. The owner
supplies any necessary information directly to a secure HoBo owner form and
HoBo keeps it in the temporary owner session. Existing owner settings may be
read from outside the repository without returning their contents to the agent.
Never inspect or quote a store reference. If this host cannot render the
secure HoBo owner hand-off, report that capability gap; do not ask the owner
to paste identifiers or values as a workaround.

For the hosted relay, HoBo CD delivers the selected Git commit to Vercel;
the Vercel project does not need a connected Git repository. A managed deploy
uses the owner's existing CD connection. A headless runner must have an
authorized owner-store session or workload identity and owner-selected store
settings outside the repository. Report a missing session accurately.

## Running `hobo ci up` / `hobo cd up` for the owner

You are usually in a box the owner cannot reach (a remote managed session).
Never give the owner a `127.0.0.1`/`localhost` link, a port to forward, or a
tunnel to set up: they cannot complete those. A handed-off run serves
nothing in the box and nothing calls back into it. Instead it names what it
needs on one line, waits, and **picks up what the owner did outside, in the
same run** (post-back). Your job is to relay each line, act on it, and wait.

**Every owner-facing line gets a structured ask, never a question in
prose.** A choice goes to a picker the host renders, a credential to the
session's credential form. If an ask does not complete (interrupted, the
session restarted, the form closed), issue it again as the first thing you
do, before any other reply. Ending a turn with a choice or credential still
unasked is a failure; `pnpm run eval:hand-off-transcript <transcript>`
checks it.

1. Run `hobo <ci|cd> up --hand-off` through the **HoBo MCP server** (its
   `ci` or `cd` tool with `args: ["up", "--hand-off"]`) when it is
   connected: that is how the run reaches the owner on a remote box (their
   sign-ins and the values they hand over wait in that server's memory). Run
   it again the same way after each owner step. Without the HoBo server,
   run `hobo <ci|cd> up --hand-off` in the background (never `--json` or
   `-q`: they hide the lines) and watch its output.
2. On `HOBO_*_STORE_CHOICE` (the owner has not chosen a store): call the
   HoBo MCP server's **`choose_secret_store`** (`mcp__hobo__choose_secret_store`,
   `family` ci or cd). It shows the owner a picker of **Infisical**,
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
3. On `HOBO_OWNER_CREDENTIAL host=<host> guide=<url> — <steps>`: the run is
   waiting for a credential. In **one** message, give the owner the steps
   from that line and the guide link exactly as printed, and ask them to
   say when it is ready. Then call `request_credential` with that `host`;
   if the line asks for a **username and password** (Bitwarden's personal
   API key: username = client_id, password = client_secret), pass
   `suggested_type: "basic"`. The form cannot show links or steps, which is
   why they come first. Once they save it, the run continues by itself; do
   not rerun it. If they decline the form, show the other paths the run's
   refusal names.
4. **Through the HoBo MCP server, the run asks the owner itself.** On a
   host that shows forms, one `cd` (or `ci`) call shows every step as a
   form in the owner's host, its link inside it: Infisical's sign-in link
   with the paste field, then Vercel's approval link and code with a
   **Done** button. You call the lifecycle and wait; you never relay a
   link, a code or a step in chat, and you never call `capture_secret` for
   a value the run is waiting on. If the call ends with
   `HOBO_OWNER_SIGN_IN` or `HOBO_CD_VERCEL_AWAITING_APPROVAL` (the owner
   closed a form), run the lifecycle again: the same form comes back.
   A form unanswered for 10 minutes (`HOBO_OWNER_FORM_WAIT_MS`) is
   withdrawn and the call ends the same way, so it never hangs. If a form
   went unanswered, the owner may not see forms where they are: as the
   fallback, show the link from that line once in chat, on its own line,
   then run again when they say they are ready.
   Only a host that shows no form gets a refusal to act on in chat (below).
   Never ask for the value in chat, and never use `request_credential` for
   it (that form feeds the network proxy, not the run).
   On `HOBO_OWNER_CAPTURE name=<name> guide=<url>` (one line per value: a
   self-hosted Bitwarden API key, a remote 1Password sign-in, a CI setting):
   give the owner the guide link and call `capture_secret` once per `name`,
   one form at a time; run again when all are in. The run spends none of
   them until all have arrived.
   `capture_secret` shows the owner a form their host renders: HoBo's MCP
   App, or, where the host has none, the host's own elicitation form (its
   result's `hostSupport` says which). Tell the owner to use the form only
   when the result shows one (`channel` `mcp-app`, or `status: stored` from
   the elicitation form). On `SECRET_CAPTURE_NO_OWNER_FORM` (a remote box
   whose host shows neither), say this host cannot collect the value and
   name a host that can; never send them to a page, a preview or the chat.
5. On `HOBO_OWNER_BITWARDEN_APPROVE server=<host> phrase=<phrase>`: say
   "Open a Bitwarden app signed in to `<host>` and approve the login request
   from HoBo whose fingerprint phrase is `<phrase>`." The run then sets up
   its own access (a project, machine account and one-day token, or a
   collection of encrypted notes where the server has no Secrets Manager)
   and continues; do not rerun it. On `HOBO_*_BITWARDEN_ORGANIZATION`, ask
   the owner to select their organization in the secure HoBo form. If the
   host cannot show that form, report the missing capability.
6. On `HOBO_OWNER_DEVICE <link> code=<code>` (cd), from a host that shows
   no form: say once "Approve HoBo CD on Vercel at `<link>`, on any device
   (the code is `<code>`), then tell me", end your turn, and when they say
   approved, run the lifecycle again; the grant completes in the server and
   writes the connection to the store. At a terminal, the run waits and
   continues by itself.
7. When the run ends: report its last lines. If it refused, show its code
   and its applicable remediation, excluding any private coordinates or
   references. Never repeat private information from a diagnostic.

**Creating the GitHub App for the owner.** Use the HoBo MCP owner hand-off
for `hobo ci app create --hand-off` so the owner can approve the App and
supply any one-time code directly to the run. Never ask the owner to send a
code or an identifier to the agent, and never transfer one through chat,
command arguments, stdin, or a file. If the host cannot render the secure
hand-off, report that capability gap. Never point the owner at the relay or
any shared service for the App's code.

What the run already does, so don't do it yourself: a handed-off run signs
in to Infisical through the session's egress proxy (`INFISICAL_SIGN_IN`
defaults to `egress-proxy` when no sign-in was selected), holding only a
placeholder, unless it runs as a workload with its own OIDC. An explicit
sign-in choice is preserved; `ci` reads the relay's own folder
(`/hobo-ci-relay`), so the relay's existing GitHub App is reused. Creating a
new App needs GitHub's page: a handed-off `ci` refuses with
`HOBO_CI_APP_NEEDS_OWNER` and a `HOBO_OWNER_SIGN_IN … capture=GITHUB_APP_CODE`
link to HoBo's static hand-off page (step 4), which the owner opens on any
device; GitHub's one-time code comes back only through the capture form.
Never route it through a relay or any shared service.

**At the owner's own terminal** (no `--hand-off`), the run serves the local
setup page (`HOBO_OWNER_PAGE`) and opens their browser; there they may also
sign in to Infisical by approving an OAuth application
(`INFISICAL_SIGN_IN=oauth`: Organization Settings → OAuth Applications →
Add, Name `HoBo`, Access token lifetime 1 Hours, Flow **Authorization
code**, Redirect URI `http://127.0.0.1:8793/infisical/callback`, **Require
PKCE** on). That page is for their machine only, never a remote box. OAuth
tokens only read secrets, so writes still need a token or CI's OIDC.

Never fetch or submit a page, approve a code, or read a secret yourself.
Secret variables in the agent's environment are ignored on purpose.

## Reporting

Report the deployment outcome and verified checks. State any missing secure
owner hand-off or workload session. Never report store coordinates, project
or vault identifiers, connection references, tokens, or captured values.
