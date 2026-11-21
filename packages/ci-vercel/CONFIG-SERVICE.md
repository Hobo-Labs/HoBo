# The relay's config service

Phase 3 of ADR-0179 (`docs/design/adr/hosted-relay-stateless.md`, PR #1887):
the hosted relay reads its configuration and secrets from a separate service,
read-only, and holds no secret to do it. Which service is decided when the
HoBo deployment runs, not beforehand: HoBo routes `secrets.config-service/v1`
to a store, provisions it and hands it to the owner by claim
([below](#where-the-store-comes-from-chosen-at-deploy-handed-over-by-claim)).
The relay reads it through [`@hobo/adapter-infisical`](../adapters/adapter-infisical/README.md).

What exists now: the loader (`src/relay-runtime-config.ts`), the adapter,
`hobo ci app create`, and (phase 6) the relay's Yard and the deploy workflow on
`main` ([below](#the-deploy-workflow-on-main)). Since phase 4b `entry.ts` loads the relay's configuration
through this loader (see [The stateless relay](README.md#the-stateless-relay)),
and the queue consumers read the handoff origin and `CRON_SECRET` from it.
Nothing here has been run against Infisical, GitHub or Vercel; the tests use
local stand-ins.

## How the relay signs in

The relay is a Vercel Function. Each request carries a Vercel OIDC token
(`getVercelOidcToken()` of `@vercel/oidc`). The relay posts it to Infisical's
OIDC Auth login (`POST /api/v1/auth/oidc-auth/login`, `{identityId, jwt}`) and
gets a short-lived access token, which it keeps in memory until shortly before
`expiresIn`. With it, one `GET /api/v4/secrets` lists the relay's folder: the
config document and every secret in one request. The loader keeps the parsed
result for a minute; a failed refresh keeps the last good copy.

Vercel's token claims, for team issuer mode
([Vercel OIDC reference](https://vercel.com/docs/oidc/reference)):

| Claim | Value |
|---|---|
| `iss` | `https://oidc.vercel.com/<team-slug>` |
| `aud` | `https://vercel.com/<team-slug>` (the default audience) |
| `sub` | `owner:<team-slug>:project:<project-name>:environment:production` |
| `owner_id`, `project_id`, `environment` | `team_…`, `prj_…`, `production` |

Function tokens for production last two hours, and Vercel says not to cache
them; the relay asks for one per login and caches only Infisical's token.

## Where the store comes from: chosen at deploy, handed over by claim

There is no one-time owner setup. The ADR-0179 amendment
[Secret store chosen at deploy, provisioned by claim](../../docs/design/adr/hosted-relay-stateless.md#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)
replaced the eight-step checklist that stood here: nothing is created by hand,
nothing lives in Vercel environment secrets, and nothing lives in GitHub
secrets or variables.

The store is the capability `secrets.config-service/v1`. When the HoBo
deployment runs, an agent following the [`hobo-deploy`](../../.claude/skills/hobo-deploy/SKILL.md)
skill asks HoBo to route it ([`@hobo/secret-store-claim`](../secret-store-claim/README.md)):

```sh
hobo ci secret-store plan --json        # which offer, and why the others were passed over
hobo ci secret-store provision --team <team_id> --vercel-team-slug <slug> \
  --vercel-project-id <prj_id> [--fleet-host https://...] [--owner-email <address>]
hobo claim open secret-store            # the OWNER runs this, in their own terminal
hobo claim finalize secret-store
```

| Preference | Offer | How the owner takes it | Relay can read it |
|---|---|---|---|
| 1 (default) | Infisical Cloud with OIDC Auth: the owner signs up in the web app and creates the project and three OIDC identities (the `hobo-deploy` skill walks it) | the owner's own account; `hobo ci secret-store connect` records the ids; no token anywhere | yes |
| 2 | Infisical on the owner's compute fleet, bootstrapped by HoBo (chosen by naming `--fleet-host`) | a sealed sign-in, revealed once by `hobo claim open`; finalize revokes HoBo's bootstrap identity | yes |
| 3 | Any store that publishes auth.md with anonymous agent registration | the store's own claim page, opened through `hobo claim open` | designed |
| 4 | HoBo's config-service Worker on a Cloudflare temporary account (an experiment) | Cloudflare's claim page, within 60 minutes | designed |
| 5, 6 | 1Password, Bitwarden Secrets Manager | the owner's own account | never for the relay: a workload needs a stored token |

HoBo routes to the first offer whose evidence is present, whose runtime
binding is built and whose workloads sign in without a stored token;
`--allow-designed` lifts the second gate, never the third. Infisical Cloud
with OIDC Auth is the default (the owner's choice, 2026-11-12); the Cloudflare
Worker and auth.md stores would be provisioned and claimed by the same command
once their runtime binding lands (the amendments say what is built).

### The relay's store today: secretless first

The ADR-0179 amendment
[Secretless first](../../docs/design/adr/hosted-relay-stateless.md#amendment-secretless-first)
narrows the table above for the hosted relay. It deploys to its Vercel
project `hobo-ci` through Vercel's Git integration (no deploy token), and the
owner handles no secret value on the default path:

- **A secrets manager, chosen secretless first.** The requirement is
  `secrets.config-service/v1` behind the `SecretsPort`, with three providers:
  Infisical (OIDC Auth trusts the relay's Vercel OIDC token: no stored
  credential), 1Password and Bitwarden Secrets Manager (a workload needs a
  stored token, so they serve the owner's side and are never the relay's
  runtime store). Routing records each offer's `runtimeAuth` and passes over
  `stored-token` ones. The Cloudflare Worker (offer 2) is an experiment.
- **Fewer secrets.** No `VERCEL_TOKEN`; `HOBO_CI_SESSION_KEY`,
  `HOBO_CI_SANDBOX_PROXY_TOKEN_KEY` and `CRON_SECRET` are derived from the App
  private key (`src/relay-derived-keys.ts`; a stored value still wins); the
  GitHub App's key, webhook secret and client secret go from GitHub's
  manifest conversion straight into the store (`hobo ci app create
  --via-workflow`, then the deploy workflow's `app-credentials` job runs
  `hobo ci app deposit` as `hobo-ci-writer` over GitHub OIDC); the cache's
  default member is Vercel Blob over OIDC. The amendment's table lists every
  secret, what it became and the vendor evidence.
- **Coordinates in the repository.** In production (`VERCEL_ENV=production`,
  no `HOBO_CI_CONFIG_SERVICE`), the loader reads the store's origin, project,
  environment, folder and the relay's identity from the committed
  `deploy/secret-store.binding.json`, bundled with every function
  (`vercel.json` `includeFiles`). No environment variable is set through
  Vercel's API.
- **Connecting** (once): the `hobo-deploy` skill walks the owner through the
  dashboard one step at a time, every value prefilled: projects `hobo-ci`
  (folder `/hobo-ci-relay`, `prod`) and `hobo-ci-deploy` (`prod`);
  `hobo-ci-relay` with OIDC Auth trusting Vercel (issuer
  `https://oidc.vercel.com/tyler-r-kendricks-projects`, subject
  `owner:tyler-r-kendricks-projects:project:hobo-ci:environment:production`,
  audience `https://vercel.com/tyler-r-kendricks-projects`, `project_id` and
  `owner_id` pinned), Viewer, in `hobo-ci`; `hobo-ci-writer` with OIDC Auth
  trusting GitHub Actions, create/edit, in `hobo-ci`; and
  `hobo-ci-deploy-reader` with OIDC Auth trusting GitHub Actions, read-only
  Viewer, in `hobo-ci-deploy` only. The writer job uses protected GitHub
  environment `hobo-ci-app-credentials`; the deploy job uses
  `hobo-ci-deploy`. Their respective OIDC subjects end in
  `:environment:hobo-ci-app-credentials` and `:environment:hobo-ci-deploy` after
  GitHub's immutable repository prefix. Both trusts pin `repository_id`
  `1274791462`, `repository_owner_id` `344805935`, that distinct `environment`,
  and `job_workflow_ref`
  `Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main`. An
  unrelated workflow or reusable-workflow caller therefore cannot authenticate
  either identity. The writer's audience is `https://github.com/Hobo-Labs`; the
  reader's is `https://github.com/Hobo-Labs/hobo-ci-deploy-reader`. Audience is
  caller-selected, so the environment and workflow claims—not the audience—keep
  a reader-eligible job from authenticating as the writer. (**Connected:** Tyler
  approved using built-in project **Member** (formerly Developer) for
  `hobo-ci-writer` on `hobo-ci` instead of a custom create/edit-only role.
  Infisical Cloud **Free** has no custom project roles ([pricing](https://infisical.com/pricing) — “Custom roles, multi-role, temporary access” on **Advanced** and up; checked 2026-11-12). **Member** is read/write on secrets across all project environments ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12). That residual applies only to the writer: Member is not an acceptable role for `hobo-ci-deploy-reader`.) Then:

  ```sh
  GH_TOKEN=$(gh auth token) hobo ci secret-store connect --cwd packages/ci-vercel \
    --repo Hobo-Labs/HoBo --project-id <hobo-ci> --deploy-project-id <hobo-ci-deploy> \
    --relay-identity-id <hobo-ci-relay> \
    --deploy-identity-id <hobo-ci-writer> \
    --deploy-credential-identity-id <hobo-ci-deploy-reader> \
    --team team_BRBUnG6uGhSsVV3EG5GFV3FM
  ```

  `connect` resolves the deploy trust from GitHub: `sub_claim_prefix` from
  `GET /repos/{owner}/{repo}/actions/oidc/customization/sub` (or the
  immutable form built from `GET /repos/{owner}/{repo}`'s ids when the
  template says `use_immutable_subject`), checked against the repository's
  ids, then `:environment:hobo-ci-app-credentials` for the writer (the reader
  gets `:environment:hobo-ci-deploy`); it fails closed
  (`HOBO_CI_SECRET_STORE_OIDC_SUBJECT_UNRESOLVED`, with the `gh api` command
  to check) when GitHub does not say, and never writes a glob such as
  `repo:Hobo-Labs@*/HoBo@*` (it would match a recycled name). The binding
  records the subject (`deployOidcSubject`) and keeps the reader's id in
  `deployCredentialIdentityId`, distinct from the writer's `deployIdentityId`.
  **Repair:** re-run `connect` (no ids needed once the binding exists; adding
  the deploy project and reader needs both ids and `--yes`); with
  `INFISICAL_TOKEN` from your own `infisical login` for that one run it
  replaces each GitHub Actions identity's OIDC trust in place, reader first
  (so a typo'd reader id fails before the writer's working trust is touched),
  writer second, reader at the reader audience and writer at the writer
  audience (`PATCH /api/v1/auth/oidc-auth/identities/{id}`, no new identity),
  and writes nothing if either update fails; otherwise it prints both exact
  trust configurations to set in the dashboard. When
  `verify` is denied with a token whose `sub` differs from that subject (or is
  immutable while no subject was recorded), its failure says so and names this
  repair.

- **The remainder.** Only an optional third-party cache credential
  (`VALKEY_URL`, a `TURSO_AUTH_TOKEN` the Marketplace does not manage) is
  ever typed by a person, into the HoBo MCP App (`capture_secret` on
  `hobo-mcp`), never into the chat; it goes sealed from the form to the MCP
  server to the store. See [`@hobo/mcp`](../mcp/README.md#secret-capture-mcp-app).
- **Verifying**, by identity name and id: `hobo-ci-deploy-reader` in the deploy
  workflow's *Verify the secret store connection* step (`hobo ci secret-store
  verify --identity reader`: sign in with GitHub OIDC at
  `https://github.com/Hobo-Labs/hobo-ci-deploy-reader`, actually read
  `VERCEL_TOKEN` without logging its value, require its deploy-project membership
  to contain exactly one `viewer` role, and require HTTP **403** when listing the
  relay folder). A value-hidden response, 401, 404, timeout, store error, or any
  write-capable/custom/temporary role fails closed. `hobo-ci-writer` is verified
  separately by `verify --identity writer` in the `hobo-ci-app-credentials`
  environment before deposit: it signs in at `https://github.com/Hobo-Labs` and
  must receive HTTP **403** when listing the deploy project. The relay identity
  gets the same deploy-project denial check wherever its Vercel token is
  available. Every issued session is revoked. Failures print `oidc_sub` /
  `oidc_aud` for dashboard trust matching, never an access token or secret value.
  `hobo-ci-relay` is also checked by `/readyz` after Vercel deploys. Both
  workflow verification steps run
  `scripts/ci/relay-deploy-secret-store-verify-report.mts` so empty stdout or
  stderr-only crashes fail loudly in the log and job summary. Before either job
  installs or signs in, `scripts/ci/relay-deploy-environment.mts` requires its
  GitHub environment to have exactly one custom deployment branch policy naming
  `main`. The deploy-token read never signs in as the
  writer.

### Least privilege on Infisical Cloud Free (attach)

Tyler's org is on the **Free** plan. Custom project roles and several access
controls are paid features ([pricing](https://infisical.com/pricing) — “Custom
roles, multi-role, temporary access” from **Advanced**; “Access controls
(RBAC/ABAC)” from **Pro**; checked 2026-11-12). **Operator decision
(2026-11-12): option (d)** — accept built-in **Member** for `hobo-ci-writer`
with compensating controls, without upgrading Infisical.

| Candidate | Free? | HoBo / relay fit |
|---|---|---|
| **(a) Additional privileges** scoped to `prod` + `/hobo-ci-relay` | **No** — privileges layer on project RBAC; Free has no RBAC/ABAC ([pricing](https://infisical.com/pricing); [additional privileges](https://infisical.com/docs/documentation/platform/access-controls/additional-privileges); checked 2026-11-12) | N/A |
| **(b) Separate writer project** (`deployProjectId` ≠ `projectId`) | Yes (second project on Free) | HoBo's **provisioned** layout splits relay vs deploy-credential projects ([`secret-store-claim`](../secret-store-claim/src/infisical.ts)). The parser now requires a deploy project for the deploy credential on every binding, attach included; `hobo ci app deposit` still writes `store.projectId`, so a second project does not isolate App-credential writes without a new connect/provision design. |
| **(c) Drop writer / Viewer-only** | — | **No** — `app-credentials` and MCP capture write into `/hobo-ci-relay` ([`relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)); verify only proves OIDC sign-in |
| **(d) Member + compensating controls** | **Yes** | **Chosen** for current attach binding |

Compensating controls for **(d)** (no dashboard change required beyond
existing OIDC):

- **Trust:** the writer subject is
  `repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials`;
  the reader subject ends in `:environment:hobo-ci-deploy`. Both pin the
  repository ids, the environment and the exact `job_workflow_ref` of
  `relay-deploy.yml` on `main`. Their audiences and environments differ, and
  neither trust admits an unrelated or reusable-workflow caller. Token TTL is
  **600s**.
- **Separation:** `hobo-ci-relay` remains **Viewer**. `hobo-ci-writer` is for
  App-credential deposit, never deploy-token reads. Deploy-token reads require
  the distinct `hobo-ci-deploy-reader`. The MCP/owner `hobo-secret-writer`
  keeps its one-use Universal Auth and has no GitHub Actions trust.
- **Scope:** relay reads `/hobo-ci-relay` in `prod`; writer deposits there;
  the deploy reader is a Viewer-only member of the `hobo-ci-deploy` project
  only. `verify` reads the deploy credential's value, checks that exact role,
  and requires HTTP **403** for the reader's relay-folder listing. The writer
  and relay identity must likewise receive HTTP **403** for the deploy project.
  A successful cross-project listing fails; 401 proves no isolation; and every
  404, timeout, store error, or inconclusive answer fails closed. The real
  cross-project response remains **built, not proven** until the production
  observation below.
- **Residual:** writer Member can read/write secrets in **all environments**
  in the project ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12) — accepted on Free until upgrade or a future **(b)** code path. This residual is not inherited by the deploy reader: without a dedicated identity in a project of its own, `deployCredentialIdentityId` stays unset and deployment refuses to read a token.

**(b)** on Free does **not** tighten today's attach binding: `hobo ci app
deposit` writes `store.projectId` and `store.secretPath`, so App credentials
stay in the relay project. A second project (`deployProjectId`) scopes the
deploy credential away from the relay project. A binding **without** a deploy
project is refused by the strict parser: Infisical project roles cover the
whole project ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12), so a
`/hobo-ci-deploy` folder inside the relay's project cannot keep the relay's
Viewer identity — or the writer's Member identity — from reading the deploy
token, and Free has no custom roles to scope a grant to one folder. The deploy
credential therefore always lives in a project of its own, at its root, read
by the dedicated deploy-credential identity (`deployCredentialIdentityId`),
never the writer in `deployIdentityId`. The owner provisions that side:
create project `hobo-ci-deploy`, create the read-only `hobo-ci-deploy-reader`
machine identity in it, and deposit the token at its root through the MCP
capture connector's `deploy` target (or `hobo-secret-writer`). The committed
attach binding currently has neither a `deployProjectId` nor a
`deployCredentialIdentityId`. The workflow gate therefore fails the relay deploy
job instead of reporting a green skip. Read-only hosting evidence can still use
the claimed legacy relay coordinates, but cannot authorize deployment. A direct
real deploy fails closed before requesting GitHub OIDC or authenticating to
Infisical, while `--dry-run` can still inspect the plan. A missing project or
token stops preview after repair. **Built, not proven**: owner provisioning of that
project, identity and token is still required before a successful
production observation can exist. After provisioning and committing the
binding, link a successful `relay-deploy` run here whose preview step records
`deploy token read from infisical://…/VERCEL_TOKEN as the binding's deploy
credential identity` — the binding's `deployCredentialIdentityId`, provisioned
as `hobo-ci-deploy-reader` — and whose *Verify the secret store connection*
step passes the reader (including the exact Viewer and refused-relay-folder
assertions), and whose production deploy and origin verification succeed. An
OIDC-only verification or skipped deploy is not evidence. Record only the
secret reference and outcomes, never the token or OIDC JWT.

**Cutover sequence** (fail closed while incomplete): while the committed binding
is incomplete, the pre-install deploy gate classifies it as unreadable and fails
the relay deploy job with a repair message. `hobo ci deploy --dry-run` can still
plan from the confined repair read; every real deploy uses the strict parser and
refuses before GitHub OIDC or Infisical authentication. The owner (Tyler)
completes provisioning before committing the repaired binding:

1. In GitHub, create protected environments `hobo-ci-deploy` and
   `hobo-ci-app-credentials`. Each must have exactly one custom deployment branch
   policy naming `main`. The workflow verifies this setting through GitHub's API
   before installation or OIDC sign-in; an absent environment or API failure
   stops the job. The deploy and `app-credentials` jobs name the environments respectively.
2. In Infisical, create project `hobo-ci-deploy` and, in it, only the read-only
   `hobo-ci-deploy-reader` machine identity with exactly Viewer. The relay and
   writer identities stay in `hobo-ci`; neither gets deploy-project membership.
3. Give the reader OIDC Auth at audience
   `https://github.com/Hobo-Labs/hobo-ci-deploy-reader`, subject prefix followed
   by `:environment:hobo-ci-deploy`, and the pinned repository ids, environment
   and exact `job_workflow_ref` documented above. Give the writer the distinct
   `hobo-ci-app-credentials` environment and its own audience. `connect` in step
   5 applies both exact configurations when given the owner's token.
4. Deposit `VERCEL_TOKEN` at the `hobo-ci-deploy` project's root through the
   MCP capture connector's `deploy` target (or `hobo-secret-writer`).
5. Run `hobo ci secret-store connect --cwd packages/ci-vercel
   --deploy-project-id <hobo-ci-deploy>
   --deploy-credential-identity-id <hobo-ci-deploy-reader> --yes`, with
   `INFISICAL_TOKEN` from the owner's own `infisical login` for that one run so
   both GitHub Actions identities' trust is repaired in place. It records the
   deploy project, reader id and writer environment subject. Without the new
   values it names both missing options instead of refusing the legacy file.
6. Commit the rewritten `deploy/secret-store.binding.json`. The gate now admits
   it, and the next `relay-deploy` run must provide the production observation
   above: value read as the dedicated reader, exact Viewer and HTTP 403 scope
   checks, then successful production deploy and origin verification.

The tightened parser is the breaking change's whole blast radius: the
package is private (no external consumer), every in-repo constructor of a
binding (`provision`, `connect`, the tests) writes the deploy project and
reader id, and the MCP capture connector
([`mcp-secret-capture.ts`](../hobo/src/mcp-secret-capture.ts)) refuses a
legacy binding with the repair it names instead of authorizing a capture.
The reader id is the cutover marker: every binding shape the earlier parser
accepted — with or without a deploy project or a recorded subject, but never
a reader id — parses only for connect repair, token-free dry-run planning, and
the constrained read-only hosting observation, never for a real deploy. A
binding that records a reader id must satisfy the full modern shape everywhere:
a deploy project of its own, the writer's protected-environment subject when
claimed, and a reader distinct from the relay and writer identities. The repair
output still cannot be written back or reach a deploy-credential read.

### What provisioning creates

Two layouts put the deploy credential behind its own project walls; which one
exists depends on how the store was bound, and `deployIdentityId` names a
different identity in each.

**The provisioned layout** — what `hobo ci secret-store provision` creates, and
what an attach run with the owner's `INFISICAL_TOKEN` creates
([`secret-store-claim`](../secret-store-claim/src/infisical.ts)):

| Project | Environment / folder | Identity | Role | Trusts |
|---|---|---|---|---|
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-relay` | viewer | the Vercel team issuer: `iss`/discovery `https://oidc.vercel.com/<team-slug>`, `aud` `https://vercel.com/<team-slug>`, `sub` `owner:<team-slug>:project:hobo-ci:environment:production`, claims `owner_id` and `project_id` pinned |
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-deploy` (`deployIdentityId`) | viewer | GitHub Actions writer trust: `aud` `https://github.com/<owner>`, `sub` `<sub_claim_prefix>:environment:hobo-ci-app-credentials`, repository ids, environment and exact `job_workflow_ref` pinned; never a member of the deploy project |
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy-reader` (`deployCredentialIdentityId`) | viewer | GitHub Actions reader trust: `aud` `https://github.com/<owner>/hobo-ci-deploy-reader`, `sub` `<sub_claim_prefix>:environment:hobo-ci-deploy`, repository ids, environment and exact `job_workflow_ref` pinned; `verify` requires this exact role and HTTP 403 from the relay folder |

Only the dedicated reader is a HoBo member of `hobo-ci-deploy` in the
provisioned layout. The writer's and relay's memberships in `hobo-ci` do not
reach the credential project, and `verify` tests both denial paths. Distinct
protected environment and workflow claims also prevent a reader-eligible job
from selecting the writer's audience and authenticating as the writer.

**The attach layout** — what the owner creates by hand in Infisical's web app
and `connect` records (HoBo's own binding today):

| Project | Environment / folder | Identity | Role | Trusts |
|---|---|---|---|---|
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-relay` | viewer | the Vercel team issuer: `iss`/discovery `https://oidc.vercel.com/<team-slug>`, `aud` `https://vercel.com/<team-slug>`, `sub` `owner:<team-slug>:project:hobo-ci:environment:production`, claims `owner_id` and `project_id` pinned |
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-writer` (`deployIdentityId`) | App-credential create/edit; the accepted Free Member residual applies only here | Protected `hobo-ci-app-credentials` environment and exact deploy workflow; never deploy-project membership |
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy-reader` (`deployCredentialIdentityId`) | exactly viewer; Member, Admin, custom and temporary roles are not acceptable | Protected `hobo-ci-deploy` environment and exact deploy workflow at the reader audience; `verify` reads the value and requires HTTP 403 from the relay folder |

In the attach layout the writer lives in the relay's project and the reader in
`hobo-ci-deploy`, so project membership is the separation and the writer's
Member residual never reaches the deploy credential.

Every binding — provisioned or attach — records a `deployProjectId` other
than the relay's and the read-only `deployCredentialIdentityId`, distinct from
the relay and writer identities; the parser and the deploy-token read both
refuse a binding that names the writer (or the relay identity) as the deploy
credential reader, and one without a deploy project. A binding recorded
before those fields were required makes the workflow gate fail closed and is
refused by real deploy commands until `connect --deploy-project-id …
--deploy-credential-identity-id …` records them (sequence above). The deploy credential
always has a project of its own so the relay's identity, a member of
`hobo-ci` only, can never read it (Infisical project roles cover the whole
project). Endpoints: `POST /api/v1/admin/bootstrap` (self-hosted only),
`POST /api/v1/projects`, `POST /api/v1/folders`,
`POST /api/v1/projects/{projectId}/identities`,
`GET /api/v1/projects/{projectId}/identities/{identityId}` for the reader's
roles, `POST /api/v1/auth/oidc-auth/identities/{identityId}` (`PATCH` of it on a
connect re-run), GitHub's `GET /repos/{owner}/{repo}` and
`GET /repos/{owner}/{repo}/actions/oidc/customization/sub` for the subject,
and at finalize `DELETE`/`GET /api/v1/identities/{identityId}`. The admin calls
are pinned by
[`infisical-admin.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json)
and membership by
[`infisical-api.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-api.pact.json).

The coordinates (the store's origin, project ids, the identity ids, and the
Vercel team id) are written to `deploy/secret-store.binding.json`, the
`SecretStoreBinding` record of
[`secret_store_claim.proto`](../secret-store-claim/data-models/secret_store_claim.proto).
They are ids, not credentials; committing the file is how `hobo ci deploy` and
the workflow find the store.

## What the relay deployment declares

Plain configuration on the Vercel project, not secrets:

| Variable | Value | From |
|---|---|---|
| `HOBO_CI_CONFIG_SERVICE` | `infisical` (`env`, the default, reads the environment instead) | the Yard's binding row |
| `INFISICAL_SECRET_PATH` | `/hobo-ci-relay` | the Yard's binding row |
| `INFISICAL_ENVIRONMENT` | `prod` | the production Camp |
| `INFISICAL_SITE_URL` | the store's origin | `deploy/secret-store.binding.json` |
| `INFISICAL_IDENTITY_ID` | the id of `hobo-ci-relay` | `deploy/secret-store.binding.json` |
| `INFISICAL_PROJECT_ID` | the id of `hobo-ci` | `deploy/secret-store.binding.json` |

`HOBO_CI_CONFIG_SERVICE` is a setting of the relay's Bindle
([`src/bindle.ts`](src/bindle.ts)); the `INFISICAL_*` coordinates belong to the
config-service binding of the relay's Yard ([`deploy/yard.ts`](deploy/yard.ts)),
which names the capability and the binding file and asks the deploy for the
three inputs. `hobo ci deploy` fills them, and the Vercel team, from the
committed binding (a `--set` still wins), and sets them on the project for
production; nobody types them into Vercel.

## The deploy workflow on `main`

[`.github/workflows/relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)
deploys the relay to production on every push to `main` that changes it, and on
a manual run (Actions → HoBo relay deploy → Run workflow). It never asks anyone
to deploy, holds no secret and reads no repository variable about the relay:
its gate is the committed binding (no binding, or an unreadable one: a notice,
and the job succeeds), and its credential step signs in to the store with the
job's GitHub Actions OIDC token as `hobo-ci-deploy-reader` from
`deployCredentialIdentityId` and reads `VERCEL_TOKEN` from the deploy
project's root, masked in the log. A
binding that names only the writer, or has no deploy project, stops preview
before sign-in. A `route` job picks the
runner first, as `hobo-ci.yml` does (the fleet while it takes jobs, an
enrolled box, else GitHub-hosted), so a busy fleet no longer holds the deploy
and every later one in its concurrency group.

How `VERCEL_TOKEN` gets into the store is a claim step, designed and not built
(the amendment's [deploy credential](../../docs/design/adr/hosted-relay-stateless.md#the-deploy-credential)
records why): Vercel offers no flow in which an agent obtains a token for a
team it does not own, and its claimable deployments cannot target an existing
project. Until then the owner's own `vercel login` session is the only source,
used once, and the token goes nowhere but the deploy project.

### What the workflow does, and the claim steps the skill drives

Automated, on every deploy: the setting of the production Camp's non-secret
configuration, the deployment of the pushed commit, the wait for READY, a smoke
check (a 5xx from `/healthz` fails the job; `/readyz` is reported, and answers
`config-unavailable` until the folder above is filled), and the attachment of
the cache.

**Today the workflow adopts instead** (Vercel's Git integration deploys; no
deploy token): `hobo ci deploy --adopt` replaces the smoke check with HoBo CD's
fail-closed verification: preview by the deployment's GitHub record (READY, of
the commit), production at the relay's production domain (the Yard's
`productionOrigin`, public under Standard Deployment Protection), whose
`/healthz` must name the commit and whose `/readyz` must answer 200. So
production is not qualified until the folder above is filled; until then the
run fails as `HOBO_CI_DEPLOY_RELAY_NOT_CONFIGURED` (`/readyz` reports
`state: "not-configured"`), and a store that refuses the relay identity as
`HOBO_CI_DEPLOY_RELAY_NOT_READY` (`config-service-denied`), each with its
remediation ([README](README.md#token-free-relay-mode-hobo-ci-deploy---adopt)).

**`hobo ci deploy` delivers through HoBo CD.** Run with a deploy token
(by hand, see the [README](README.md#deploying-the-relay-with-hobo)), it
records the commit as Freight, delivers it to preview and verifies it there
(`/healthz` only: the preview Camp has no config-service binding, so its
`/readyz` answers 503 `started:false`), then promotes it to production only
because preview qualified it, sets the production Camp's non-secret
configuration, waits for READY and verifies `/healthz` and `/readyz` (each must
answer 200). Production is not deployed until preview qualifies the commit; a
production deployment that fails verification stays live on Vercel (nothing
rolls it back) and is not qualified. The workflow does not run it today: it
holds no Vercel token (secretless first), so Vercel's Git integration deploys
and the workflow records no relay Freight. The cache step runs the Vercel CLI (pinned `vercel@65.2.0`) with the
deploy token in its environment: it lists the project's `upstash` resources,
and, when `hobo-ci-cache` is missing, connects the team's resource of that name
for production or provisions one (`vercel integration add upstash/upstash-kv
--name hobo-ci-cache --environment production --no-env-pull --non-interactive`).
Its outcome is in the job summary; a failure there does not stop the deploy.

Not a checklist: the [`hobo-deploy`](../../.claude/skills/hobo-deploy/SKILL.md)
skill surfaces each of these to the owner as a claim step, at the moment it is
needed, with what it approves. Each is a person's act by the vendor's design:

1. **The Upstash integration's terms.** Vercel accepts a Marketplace
   integration's terms only from a person (`vercel integration accept-terms`
   needs a terminal). One approval on the team; the workflow then provisions
   `hobo-ci-cache` on its next run.
2. **The team issuer for OIDC** on the relay's project, which the relay's
   identity trusts. Designed: `hobo ci deploy` sets it through the project
   API in the owner's claimed session; until then, one toggle (Project →
   Settings → Security → *Secure backend access with OIDC federation* → Team).
3. **Neon, once phase 8 has cut over**, is disconnected (Project → Settings →
   Integrations → Neon). Turso stays: it is a member of the cache fleet on its
   free plan ([options routed by budget](../../docs/design/hosted-relay-stateless.md#options-routed-by-budget)).

Not provisioned by the workflow, by design: Turso, Vercel Blob and Valkey are
rows of the Yard's catalog that no Camp chooses. Choosing one is a change to
`deploy/yard.ts` (a Camp's `require`), reviewed like any other. A cache that is
already bound to the project (Turso through its existing integration, or
`VALKEY_URL`/`BLOB_STORE_ID` in the config service) still joins the cache fleet
([The cache fleet](README.md#the-cache-fleet)), which picks one by budget.

## What the folder holds

One entry per key, named as the relay's environment variable; the loader
refuses a folder holding any other key, and names it (never its value).

| Entry | Required | Written by |
|---|---|---|
| `HOBO_CI_PUBLIC_URL`, `HOBO_CI_SESSION_KEY`, `HOBO_CI_BOOTSTRAP_ACCOUNT_ID`, `HOBO_CI_BOOTSTRAP_TOKEN_SHA256`, `HOBO_CI_CONTROL_TOKENS_JSON`, `HOBO_CI_CONFIG_JSON` (the config document), `CRON_SECRET` | yes | owner, later `hobo ci` |
| `HOBO_CI_INVITATION_EXPIRES_AT`, `HOBO_CI_ONBOARDING_CONTROL_TOKEN`, `HOBO_CI_SANDBOX_ENABLED`, `HOBO_CI_SANDBOX_TEAM_ID`, `HOBO_CI_SANDBOX_PROJECT_ID`, `HOBO_CI_SANDBOX_ISSUER`, `HOBO_CI_SANDBOX_PLAN`, `HOBO_CI_SANDBOX_DOMAINS_JSON` | no | owner |
| `HOBO_CI_SANDBOX_PROXY_TOKEN_KEY` (32 random bytes, base64url: each Sandbox proxy session token is derived from it, so none is stored) | with `HOBO_CI_SANDBOX_ENABLED` | owner |
| `HOBO_CI_GITHUB_APP_ID`, `HOBO_CI_GITHUB_APP_CLIENT_ID`, `HOBO_CI_GITHUB_APP_PRIVATE_KEY`, `HOBO_CI_WEBHOOK_SECRET`, `HOBO_CI_GITHUB_APP_CLIENT_SECRET` | yes | `hobo ci app create` (its manifest page is the GitHub App's claim step: one browser click by GitHub's design, see [`hobo ci app create`](../hobo/CI.md#create-the-hosted-relays-github-app)) |
| `VALKEY_URL` (`redis://` or `rediss://`, with its password), `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, `BLOB_STORE_ID` | no | owner: cache-fleet members the deployment's environment does not bind, typically the Aiven for Valkey URL (ADR-0179 one-time action 4). A name the environment also sets keeps the environment's value; start-up logs only which names came from here |
| `HOBO_CI_CACHE_OFFERS_JSON` (a `RelayCacheOffers` document, [`data-models/cache_offers.proto`](data-models/cache_offers.proto)) | no | owner: the cache fleet's offers, budget caps and switch marks; defaults come from the offer catalog in [`offers/`](offers/) ([Offers as provider manifests](README.md#offers-as-provider-manifests)) |

**What the relay does with the onboarding entries** (phase 5,
[Helpers on the cache](README.md#helpers-on-the-cache)). It only reads them.
`HOBO_CI_SESSION_KEY` keys the cache's session records (an HMAC names each)
and seals the ones that hold a credential; rotating it signs every operator
out. `HOBO_CI_BOOTSTRAP_TOKEN_SHA256` and `HOBO_CI_INVITATION_EXPIRES_AT` are
the owner's invitation: without an expiry it is never accepted, and once
redeemed the cache holds a consumed marker until it expires, so `hobo ci`
writes a new one for the next owner. `HOBO_CI_ONBOARDING_CONTROL_TOKEN` is what
the owner's ten-minute session stands for. An installation an operator
verifies is not written here by the relay: it is usable for a day and logged
by id, for `hobo ci` to add to `HOBO_CI_CONFIG_JSON`.

The constraints are those of the relay runtime configuration schema
([`src/relay-runtime-config-schema.ts`](src/relay-runtime-config-schema.ts)) plus
the App's: an RSA key of 2048 bits or more, a webhook secret of 32 bytes or
more. The record is `RelayRuntimeConfig` in
[`data-models/relay_runtime_config.proto`](data-models/relay_runtime_config.proto)
(JSON names are the keys), with CUE constraints in
[`data-models/relay-runtime-config/relay_runtime_config.cue`](data-models/relay-runtime-config/relay_runtime_config.cue);
`test/relay-runtime-config.test.ts` pins the schema's keys and optional fields
to the protobuf record.

## Open questions

- Infisical free-plan limits on projects, machine identities and API rate are
  checked when an attach-only organization is used.
- That a project-scoped identity (`POST /api/v1/projects/{projectId}/identities`)
  takes OIDC Auth through `POST /api/v1/auth/oidc-auth/identities/{identityId}`
  is read from the OpenAPI document, not observed.
- That GitHub accepts a loopback `redirect_url` in an App manifest is assumed
  (tools such as Probot rely on it), not checked here.
- That an Infisical `PATCH` of a missing secret answers 404 (the adapter then
  creates it) follows the API reference; it is not observed here.
