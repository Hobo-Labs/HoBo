---
name: hobo-deploy
description: Use when running a HoBo deployment that needs a secrets manager — deploying the hosted CI relay to its Vercel project `hobo-ci` (Vercel's Git integration, the relay deploy workflow), or any `hobo deploy` whose Yard binds `secrets.config-service/v1`. Secretless first, so the owner handles no secret value on the default path: the deploy needs no token, keys are derived, GitHub's App credentials go straight into the store, workloads sign in with OIDC. Defaults to Infisical Cloud with OIDC Auth (nothing to install, no terminal sign-in); offers 1Password or Bitwarden only when the owner asks, with the official install path; walks the owner through OIDC trust one step at a time, verifies each identity by name, and captures any optional leftover secret with the HoBo MCP App so the value never enters your context.
---

# HoBo deployment: secretless first, a secrets manager for the rest

The rule is ADR-0179's amendment "Secretless first"
(`docs/design/adr/hosted-relay-stateless.md#amendment-secretless-first`). In
one line: **the relay deploys where it always has (Vercel project `hobo-ci`,
through Vercel's Git integration); nothing it needs is a token a person
handles; the few secrets that exist live in a secrets manager the relay
signs in to with OIDC.**

## Fixed facts (do not ask the owner for these)

| What | Value |
|---|---|
| Deploy target | Vercel project `hobo-ci` (`prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO`), team `tyler-r-kendricks-projects` (`team_BRBUnG6uGhSsVV3EG5GFV3FM`), Yard `hobo-ci-relay`; deployed by Vercel's Git integration on a push to `main` |
| Repository | `Hobo-Labs/HoBo`; `.github/workflows/relay-deploy.yml` verifies, finds the deployment, smoke-checks |
| Relay runtime store | a secrets manager the relay signs in to with its Vercel OIDC token: today only **Infisical** can (OIDC Auth); folder `/hobo-ci-relay` of project `hobo-ci`, environment `prod` |
| Identities | `hobo-ci-relay` (OIDC, Vercel, Viewer/read), `hobo-ci-writer` (OIDC, GitHub Actions on `main`, write-capable: Advanced+ custom create/edit-only, Free **Member**) |
| Binding | `packages/ci-vercel/deploy/secret-store.binding.json` (ids only) |
| Secrets a person handles on the default path | **none** |

What no longer exists, so never ask for it: a Vercel deploy token, the
session key, the Sandbox proxy key, `CRON_SECRET` (derived from the App
key), the GitHub App's key, webhook secret and client secret (GitHub hands
them to the store), Upstash or Blob tokens (Blob signs in with OIDC). The
Cloudflare temporary-account Worker store is an experiment, not the relay's
store.

## Never

- Never ask for a secret in the chat, and never put one in a command line,
  a file, `vercel env`, `gh secret set` or `gh variable set`. If the owner
  pastes one into the chat anyway: say it is now exposed, do not repeat or
  store it, and have them rotate it.
- Never read a secret's value with a tool that would print it to you
  (`op read`, `bws secret get`, `infisical secrets get`, an MCP tool that
  returns values). Names and references only.
- Never open, fetch or submit a HoBo capture page yourself.
- Never deploy the relay anywhere but Vercel project `hobo-ci`.
- Never dump a checklist. One action per message; wait for "done" (or the
  id you asked for) before the next.

## The loop

### 1. Which secrets manager?

**The default is Infisical Cloud with OIDC Auth.** Nothing has to be
installed and nobody signs in from a terminal: the owner works only in
Infisical's web app, the deploy workflow signs in with its GitHub OIDC token
and the relay with its Vercel OIDC token. Run
`hobo ci secret-store verify --cwd packages/ci-vercel --json`: a binding
means go to **4**; `HOBO_CI_SECRET_STORE_NOT_CONNECTED` means go to **2**.

Offer another manager only if the owner asks, or names one they already
use. First see what the agent has (`command -v infisical op bws`; an
Infisical MCP server, the 1Password plugin's MCP server or a Bitwarden MCP
server among your tools), then say once, plainly:

> The relay itself needs a store it can read with no stored token; only
> Infisical (OIDC Auth) does that today. **1Password** and **Bitwarden
> Secrets Manager** need a token for any workload (1Password: a
> service-account token, its GitHub federation still needs an integration
> key and does not cover Vercel; Bitwarden: a machine-account access token,
> and `bw` needs a typed master password), so they can be your own vault
> and serve this agent, not the relay at runtime.

If they want one installed for their own use, give only that one's official
path: Infisical CLI `brew install infisical/get-cli/infisical` or
`npm install -g @infisical/cli` (MCP server `@infisical/mcp`); 1Password CLI
`op` and the Claude Code plugin
(`/plugin marketplace add 1Password/1password-claude-plugin`, then
`/plugin install 1password@1password`; its MCP server returns names, never
values); Bitwarden Secrets Manager CLI `bws` (releases of
`bitwarden/sdk-sm`). Self-hosted Infisical (`--fleet-host`) and the
Cloudflare Worker are not the default; do not propose them unprompted.

### 2. Connect the relay's store with OIDC (once)

Infisical Cloud has no agent signup, so the owner does these in the
dashboard. **One step per message**, every value filled in; collect the ids
they paste (identifiers, not secrets).

1. "Sign in at https://app.infisical.com (or create an account). Tell me when
   you are on the organization's home page."
2. "Create a project: **Secret Management**, name `hobo-ci`. In environment
   **Production** (`prod`), add a folder `hobo-ci-relay`. Paste the
   **Project ID** (Project Settings)."
3. "Organization → Access Control → Identities → **Create Identity**
   `hobo-ci-relay`, organization role **No Access**. Under Authentication,
   remove Universal Auth and add **OIDC Auth**:
   - OIDC Discovery URL: `https://oidc.vercel.com/tyler-r-kendricks-projects`
   - Issuer: `https://oidc.vercel.com/tyler-r-kendricks-projects`
   - Subject: `owner:tyler-r-kendricks-projects:project:hobo-ci:environment:production`
   - Audiences: `https://vercel.com/tyler-r-kendricks-projects`
   - Claims: `project_id` = `prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO`, `owner_id` = `team_BRBUnG6uGhSsVV3EG5GFV3FM`
   - Access Token TTL `3600`, Max TTL `3600`

   Add it to project `hobo-ci` with role **Viewer**. Paste its **ID**."
   (Vercel project `hobo-ci` → Settings → Security → OIDC Federation must be
   on, issuer mode **Team**; you may check read-only with the Vercel MCP.)
4. In project `hobo-ci`, create identity `hobo-ci-writer` (organization role
   **No Access**) with **OIDC Auth**:
   - OIDC Discovery URL and Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main`
     (GitHub's immutable subject for this repository: owner and repository
     suffixed with their ids. Do not use the legacy
     `repo:Hobo-Labs/HoBo:ref:refs/heads/main` (Infisical answers 403) or a
     glob like `repo:Hobo-Labs@*/HoBo@*` (it matches a recycled name). For
     another repository, take the value `connect` prints in step 5.)
   - Audiences: `https://github.com/Hobo-Labs`
   - Claims: `repository_id` = `1274791462`, `repository_owner_id` = `344805935`
   - Access Token TTL `600`, Max TTL `600`

   **Role:** **Advanced+** — add custom role `hobo-ci-writer` (create/edit
   only on `prod` + `/hobo-ci-relay`) and assign it. **Free plan** — assign
   built-in project **Member** (see `packages/ci-vercel/CONFIG-SERVICE.md` §
   *Least privilege on Infisical Cloud Free (attach)*). Paste its **ID**."
5. You run:

   ```sh
   GH_TOKEN=$(gh auth token) hobo ci secret-store connect --cwd packages/ci-vercel \
     --repo Hobo-Labs/HoBo --project-id <hobo-ci id> \
     --relay-identity-id <hobo-ci-relay id> \
     --deploy-identity-id <hobo-ci-writer id> --team team_BRBUnG6uGhSsVV3EG5GFV3FM
   ```

   It reads from GitHub the OIDC subject the repository's tokens carry (fails
   closed with the `gh api` check if GitHub does not say), prints the exact
   subject and claims for `hobo-ci-writer`, and writes the binding (ids and
   that subject only). If they differ from step 4, fix the dashboard to match.
   Commit it in a PR and merge it.

   **Repair** (verify says the token's subject differs from the trust): re-run
   `connect` with `--repo` (no ids needed once the binding exists). With
   `INFISICAL_TOKEN` from the owner's own `infisical login` for that one run,
   it updates `hobo-ci-writer`'s OIDC trust in place; otherwise walk the owner
   through setting the printed subject and claims.

### 3. Fill the store, with no secret passing through anyone

1. **The GitHub App** (only if the relay has none). Run
   `hobo ci app create --relay <relay origin> --owner-id <owner's numeric
   GitHub id> --via-workflow`. The owner clicks **Create GitHub App** on
   GitHub's page (the one click that stays); HoBo hands GitHub's one-time
   code to the deploy workflow, whose `app-credentials` job writes the key,
   webhook secret, client id and client secret straight into the store as
   `hobo-ci-writer`. Watch it with `gh run watch`; report the job's line.
2. **The cache.** Ask the owner to connect a **Blob** store to `hobo-ci`
   (Vercel → Storage → Create → Blob → connect to `hobo-ci`, Production).
   The relay signs in to it with OIDC (`BLOB_STORE_ID` only); if Vercel also
   added `BLOB_READ_WRITE_TOKEN`, it may be removed.
3. **Anything optional and third-party** (a Valkey URL, a Turso token the
   Marketplace does not manage) is the only thing ever captured, and only
   if the owner wants that cache member. Then:
   1. Once: "Create Identity `hobo-secret-writer` (organization role **No
      Access**) with **Universal Auth**, Access Token TTL `600`, and add it to
      `hobo-ci` with the `hobo-ci-writer` role. Paste its **Client ID**."
      Each time: "→ Universal Auth → Client Secrets → **Create**, TTL `900`,
      Max Number of Uses `1`. Keep it on screen."
   2. Call `capture_secret` with `name: "INFISICAL_WRITER_CLIENT_SECRET"`
      and `writerClientId`; the owner types the secret into the HoBo form.
   3. Call `capture_secret` with `name: "VALKEY_URL"` (or
      `TURSO_AUTH_TOKEN`). If the host shows the form: "Type it into the
      form above." If the result has a `url`: "Open this page in your own
      browser on this machine." If the host asks to open a page (`-32042`):
      the host shows it; wait.
   4. `secret_capture_status` → `stored` and an `infisical://` reference;
      then `end_secret_capture`.

### 4. Verify by name, then let Vercel deploy

1. A push to `main` (the binding PR, or any relay change) makes Vercel's Git
   integration build and promote `hobo-ci`. The workflow runs alongside;
   `gh run watch` it.
2. Report **Verify the secret store connection**:
   `hobo-ci-writer (GitHub Actions OIDC): pass|fail — <detail>`
   (`login-denied`: the subject, audience or issuer of step 2.4 does not
   match).
3. Report **Find Vercel's Git deployment of this commit** (the URL) and the
   smoke check. `hobo-ci-relay (Vercel OIDC)` passes when `/readyz` answers
   `ready`; a 503 with `started: false` means the relay could not sign in or
   a value is missing; its runtime log names which (Vercel MCP
   `get_runtime_logs`, read-only).

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
   **1Password** and **Bitwarden** with each store's non-secret ids (an
   elicitation form, or an MCP App widget) and saves the answer in the
   owner's HoBo settings, never the repository. If it says the host renders
   neither, or the HoBo server is not connected, ask with your host's own
   picker (`AskUserQuestion`): the store **alone**, one question, each
   option described by its line from the refusal. Only after the owner
   answers, ask that store's own non-secret ids the same way, and nothing
   about the other stores (Infisical: `INFISICAL_PROJECT_ID`; 1Password:
   `OP_VAULT_ID`, and for a remote box `OP_CONNECT_HOST`; Bitwarden: only
   `BITWARDEN_SERVER_URL`, if self-hosted). Record them with
   `submit_store_choice` (or, without the HoBo server, run again with
   `HOBO_SECRET_STORE` and those ids set).
   Then run again: for Infisical and 1Password the run installs the
   store's CLI into HoBo's tools directory if it is missing, uses the
   owner's existing CLI session or has them sign in once (Infisical in the
   browser; 1Password approved in the 1Password app), and creates its own
   access through the provider's API or CLI (an Infisical machine identity
   with OIDC Auth where the workload has an issuer, else Token Auth; a
   one-day, vault-scoped 1Password service account). Never relay
   instructions to create identities, tokens, service accounts or Connect
   servers by hand; if a line says that, it is a bug to fix, not a step
   for the owner. From a remote box every step reaches the owner where they
   are (a link, a form): never tell them to use their own machine, a
   terminal or this box's `127.0.0.1`; a line that does is a bug to fix.
   The choice is always the owner's: a provided token only
   marks a store "configured here"; never pick a store for them because its
   token is present. Never ask the owner to set environment variables, never
   send them to a terminal, and never ask them to create identities or
   tokens by hand when the store's API can do it: the run's own lines ask for
   what it needs.
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
   which organization with a picker (each `BWS_ORGANIZATION_ID=` line is an
   option) and run again with it.
6. On `HOBO_OWNER_DEVICE <link> code=<code>` (cd), from a host that shows
   no form: say once "Approve HoBo CD on Vercel at `<link>`, on any device
   (the code is `<code>`), then tell me", end your turn, and when they say
   approved, run the lifecycle again; the grant completes in the server and
   writes the connection to the store. At a terminal, the run waits and
   continues by itself.
7. When the run ends: report its last lines. If it refused, show its code
   and **every** remediation line it printed, unparaphrased; do not reduce
   them to one option.

**Creating the GitHub App for the owner.** Run
`hobo ci app create --relay <relay origin> --owner-id <owner's numeric id>
--hand-off` in the background, with a stdin you can write to (a named pipe:
`mkfifo app.in; hobo ... < app.in &`). It prints one line; act on it:

- **With a receiver**: the owner's own outbound-only tunnel
  (`--receiver cloudflared|ngrok|localtunnel|devtunnel|pangolin|command`, or
  the non-secret `HOBO_REDIRECT_RECEIVER`). Line:
  `HOBO_OWNER_APP <https url>`. Say: "Open `<url>` on any device and click
  **Create GitHub App**." GitHub sends their browser back through the tunnel
  to this run, which stores the App; nothing else is reachable and the
  tunnel closes with the run. The run proves the tunnel carries a request
  before it shows the link. Proxies are handled for you: the run reads the
  environment's HTTPS proxy, bypass list and CA bundle up front, gives them
  to the tunnel CLI, and never starts a receiver that cannot use a required
  proxy (cloudflared, localtunnel, pangolin). On any `HOBO_REDIRECT_RECEIVER_*`
  line (no CLI, not signed in, proxy, no connection) a handed-off run falls
  back by itself to the paste hand-off below: relay its next line.
- **No receiver, paste** (default; `HOBO_APP_HANDOFF=paste`). Line:
  `HOBO_OWNER_APP <page>#<manifest>`. Say: "Open `<link>` on any device and
  click **Create GitHub App**. GitHub then shows a single-use code on that
  page: send it to me." Write their `code~state` to the run's stdin at once
  (`printf '%s\n' '<code~state>' > app.in`); never repeat it, store it or
  put it anywhere else. The run refuses a code GitHub did not issue for it.
- **No receiver, store** (`HOBO_APP_HANDOFF=store`). Line:
  `HOBO_OWNER_APP_REGISTER <github url> — <steps>`. Give the owner the link
  and steps exactly as printed; they create the App with their account and
  put its credentials in their own store. The run waits, then checks the App
  with GitHub.

Never point the owner at the relay or any shared service for the App's code.

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

End with: the secrets manager and why; the binding PR; each identity by
name with pass, fail or not-run; the App credentials job; any captured
secret by name and reference; the Vercel deployment of `hobo-ci`. Never a
value, a token or a capture page's address after it is closed.
