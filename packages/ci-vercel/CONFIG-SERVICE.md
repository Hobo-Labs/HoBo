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
replaced the eight-step checklist that stood here. Store coordinates are
committed without credentials; the relay does not need its secrets copied to
Vercel or GitHub secrets or variables.

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
| 1 (default) | Infisical Cloud with OIDC Auth | the owner's existing account and HoBo's secure owner hand-off; workloads authenticate to the store with OIDC | yes |
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
describes the relay runtime store. HoBo CD delivers the hosted relay to
Vercel project `hobo-ci` without a connected Git repository. The deploy
credential belongs in the owner's selected store, with access separate from
the runtime identity. HoBo obtains it in process through the owner session:

- **A secrets manager, chosen secretless first.** The requirement is
  `secrets.config-service/v1` behind the `SecretsPort`, with three providers:
  Infisical (OIDC Auth trusts the relay's Vercel OIDC token: no stored
  credential), 1Password and Bitwarden Secrets Manager (a workload needs a
  stored token, so they serve the owner's side and are never the relay's
  runtime store). Routing records each offer's `runtimeAuth` and passes over
  `stored-token` ones. The Cloudflare Worker (offer 2) is an experiment.
- **Derived runtime secrets.** `HOBO_CI_SESSION_KEY`,
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
  (`vercel.json` `includeFiles`). HoBo CD also sets the selected Camp
  binding's non-secret coordinates on the production project.
- **Connecting** (once): the `hobo-deploy` skill walks the owner through the
  dashboard one step at a time, every value prefilled: project `hobo-ci`
  (folder `/hobo-ci-relay`, `prod`); `hobo-ci-relay` with OIDC Auth trusting
  Vercel (issuer `https://oidc.vercel.com/tyler-r-kendricks-projects`,
  subject `owner:tyler-r-kendricks-projects:project:hobo-ci:environment:production`,
  audience `https://vercel.com/tyler-r-kendricks-projects`, `project_id` and
  `owner_id` pinned), Viewer; `hobo-ci-writer` with OIDC Auth trusting GitHub
  Actions (subject `repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main`, GitHub's immutable subject for this repository,
  audience `https://github.com/Hobo-Labs`, claims `repository_id`
  `1274791462` and `repository_owner_id` `344805935` pinned), create/edit
  only. The subject is never typed from the repository's name: `connect`
  reads it from GitHub (below), because GitHub issues
  `repo:<owner>@<ownerId>/<repo>@<repoId>:ref:refs/heads/<branch>` to a
  repository on the immutable subject format and Infisical refuses (HTTP 403)
  a trust bound to the legacy `repo:<owner>/<repo>` one. (**Connected:** Tyler
  approved using built-in project **Member** (formerly Developer) for
  `hobo-ci-writer` on `hobo-ci` instead of a custom create/edit-only role.
  Infisical Cloud **Free** has no custom project roles ([pricing](https://infisical.com/pricing) — “Custom roles, multi-role, temporary access” on **Advanced** and up; checked 2026-11-12). **Member** is read/write on secrets across all project environments ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12). `hobo ci secret-store verify` still checks OIDC sign-in only, not Infisical role shape.) Then:

  Use the HoBo owner hand-off for store selection and connection setup.
  The owner supplies private coordinates directly to its secure form, never
  through conversation, command arguments, or repository files.

- **The remainder.** Only an optional third-party cache credential
  (`VALKEY_URL`, a `TURSO_AUTH_TOKEN` the Marketplace does not manage) is
  ever typed by a person, into the HoBo MCP App (`capture_secret` on
  `hobo-mcp`), never into the chat; it goes sealed from the form to the MCP
  server to the store. See [`@hobo/mcp`](../mcp/README.md#secret-capture-mcp-app).
- **Verifying**, by identity name: `hobo-ci-writer` in the deploy workflow's
  *Verify the secret store connection* step (`hobo ci secret-store verify`:
  sign in with GitHub OIDC, audience `https://github.com/Hobo-Labs`, then
  revoke; failures print `oidc_sub` / `oidc_aud` for dashboard trust matching;
  does **not** assert Infisical role shape); `hobo-ci-relay` by `/readyz` after
  Vercel deploys. The workflow step runs
  `scripts/ci/relay-deploy-secret-store-verify-report.mts` so empty stdout or
  stderr-only crashes fail loudly in the log and job summary.

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
| **(b) Separate writer project** | Yes | HoBo's provisioned layout splits relay and deploy-credential access. App-credential writes need a separate deposit design to achieve the same isolation. |
| **(c) Drop writer / Viewer-only** | — | **No** — `app-credentials` and MCP capture write into `/hobo-ci-relay` ([`relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)); verify only proves OIDC sign-in |
| **(d) Member + compensating controls** | **Yes** | **Chosen** for current attach binding |

Compensating controls for **(d)** (no dashboard change required beyond
existing OIDC):

- **Trust:** GitHub OIDC subject `repo:Hobo-Labs@344805935/HoBo@1274791462:ref:refs/heads/main`
  (immutable; resolved by `connect`), `repository_id` and
  `repository_owner_id` pinned, audience `https://github.com/Hobo-Labs`,
  writer token TTL **600s** (Tyler configured).
- **Separation:** `hobo-ci-relay` remains **Viewer**; only relay-deploy
  workflow jobs use `hobo-ci-writer` OIDC.
- **Scope:** relay reads `/hobo-ci-relay` in `prod`; writer is for deploy
  deposit paths, not the relay runtime token.
- **Residual:** Member can read/write secrets in **all environments** in the
  project ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12) — accepted on Free until upgrade or a future **(b)** code path.

**(b)** on Free does **not** tighten today's attach binding: `hobo ci app
deposit` writes `store.projectId` and `store.secretPath`, so App credentials
stay in the relay project. A second project (`deployProjectId`) scopes only
the deploy-credential **viewer** layout from provisioned connect — not App
deposit without a new binding/connect design.

### What provisioning creates

Either Infisical offer ends in the same layout, which is what the relay's
loader and the deploy workflow read:

| Project | Environment / folder | Identity | Role | Trusts |
|---|---|---|---|---|
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-relay` | viewer | the Vercel team issuer: `iss`/discovery `https://oidc.vercel.com/<team-slug>`, `aud` `https://vercel.com/<team-slug>`, `sub` `owner:<team-slug>:project:hobo-ci:environment:production`, claims `owner_id` and `project_id` pinned |
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy` | viewer | GitHub Actions: `iss` `https://token.actions.githubusercontent.com`, `aud` `https://github.com/<owner>`, `sub` `<sub_claim_prefix>:ref:refs/heads/main` as GitHub issues it for the repository (`repo:<owner>@<ownerId>/<repo>@<repoId>` on the immutable format), claims `repository_id` and `repository_owner_id` pinned |

The deploy credential has a project of its own so the relay's identity, a
member of `hobo-ci` only, can never read it (Infisical project roles cover the
whole project). Endpoints: `POST /api/v1/admin/bootstrap` (self-hosted only),
`POST /api/v1/projects`, `POST /api/v1/folders`,
`POST /api/v1/projects/{projectId}/identities`,
`POST /api/v1/auth/oidc-auth/identities/{identityId}` (`PATCH` of it on a
connect re-run), GitHub's `GET /repos/{owner}/{repo}` and
`GET /repos/{owner}/{repo}/actions/oidc/customization/sub` for the subject,
and at finalize
`DELETE`/`GET /api/v1/identities/{identityId}`, from Infisical's OpenAPI
document (read 2026-11-12), pinned by
[`infisical-admin.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json).

The existing runtime binding describes the relay's runtime identity. The CD
connection is selected through the owner's HoBo session, not by adding deploy
store coordinates to that binding.

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

### What the workflow does and the claim steps the skill drives

[`.github/workflows/relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)
uses `hobo ci deploy --managed` to deliver the exact pushed commit through
HoBo CD. It does not ask Vercel to fetch Git or depend on a Vercel Git
connection. A missing or unreadable binding fails the deploy job.

The job verifies the relay runtime store's GitHub OIDC identity. Managed
delivery reads the separate CD connection through HoBo's generic owner-store
interface and keeps its token in memory. A headless runner must have the
owner-selected store settings outside the repository and an authorized
session or workload identity. A successful runtime-store OIDC check does not
establish that the CD connection is available. If its session is absent,
the deploy stops before contacting Vercel.

The deploy uploads a bounded committed source snapshot, qualifies preview by
its Vercel deployment record, stages production without auto-assigning its
domains, and promotes it through CD. It checks `/healthz` for the pinned
commit and `/readyz` for a 200 at the public production origin, attempting to
restore the previously serving deployment on failure. Preview protection is
not changed. See [Deploying the relay with HoBo](README.md#deploying-the-relay-with-hobo)
for recovery and checkpoint limits.

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
