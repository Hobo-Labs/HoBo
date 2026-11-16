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

## Reporting

End with: the secrets manager and why; the binding PR; each identity by
name with pass, fail or not-run; the App credentials job; any captured
secret by name and reference; the Vercel deployment of `hobo-ci`. Never a
value, a token or a capture page's address after it is closed.
