# The relay's config service (Infisical)

Phase 3 of ADR-0179 (`docs/design/adr/hosted-relay-stateless.md`, PR #1887):
the hosted relay reads its configuration and secrets from a separate service,
read-only, and holds no secret to do it. The first binding is Infisical Cloud on
the free plan, through [`@hobo/adapter-infisical`](../adapters/adapter-infisical/README.md).

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

## One-time owner setup

Do this once, in a browser, signed in to Infisical as the owner. Nothing below
puts a secret in this repository or in a Vercel environment variable.

1. **Organization.** Create an Infisical organization on the free plan
   (<https://app.infisical.com>; EU Cloud is `https://eu.infisical.com`).
2. **Projects.** Create two secret-management projects:
   - `hobo-ci`, environment `prod`, folder `/hobo-ci-relay`: the relay's
     configuration and secrets.
   - `hobo-ci-deploy`, environment `prod`: the Vercel deploy token, in a project
     of its own so that the relay's identity, a member of `hobo-ci` only, can
     never read it (project roles on the free plan are per project; folder-scoped
     custom roles may need a paid plan).
3. **Relay identity `hobo-ci-relay`** (Organization → Access Control →
   Identities → Create; then Authentication → OIDC Auth;
   [OIDC Auth fields](https://infisical.com/docs/documentation/platform/identities/oidc-auth/general)):

   | Field | Value |
   |---|---|
   | OIDC Discovery URL | `https://oidc.vercel.com/<team-slug>` |
   | Issuer | `https://oidc.vercel.com/<team-slug>` |
   | Subject | `owner:<team-slug>:project:hobo-ci:environment:production` |
   | Audiences | `https://vercel.com/<team-slug>` |
   | Claims | `project_id` = `prj_…`, `owner_id` = `team_…` (pins the ids, so a renamed or re-created project cannot match) |
   | Access Token TTL | `3600` |

   The Vercel project must use the **team** issuer mode (Project → Settings →
   Security → Secure backend access with OIDC federation). Add the identity to
   project `hobo-ci` with the **Viewer** role: read-only.
4. **Deploy identity `hobo-ci-deploy`** for the workflow on `main`
   ([GitHub OIDC with Infisical](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github),
   [GitHub's OIDC claims](https://docs.github.com/en/actions/reference/security/oidc)):

   | Field | Value |
   |---|---|
   | OIDC Discovery URL | `https://token.actions.githubusercontent.com` |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Subject | `repo:Hobo-Labs/HoBo:ref:refs/heads/main` |
   | Audiences | `https://github.com/Hobo-Labs` (GitHub's default `aud`, the owner's URL) |

   If the deploy job names a GitHub environment, GitHub's subject becomes
   `repo:Hobo-Labs/HoBo:environment:<name>`; use that instead. Repositories
   created after 2026-07-15 use an immutable subject with numeric ids: check with
   `gh api repos/Hobo-Labs/HoBo/actions/oidc/customization/sub`. Add the identity
   to `hobo-ci` with the **Developer** (member) role, which can write, and to
   `hobo-ci-deploy` with **Viewer**. The job needs `permissions: id-token: write`;
   `githubActionsJwtSource()` of the adapter reads its token.
5. **Vercel deploy token.** Create a Vercel access token scoped to the team and
   store it in project `hobo-ci-deploy`, environment `prod`, as `VERCEL_TOKEN`.
   Only the deploy identity can read it.
6. **Owner identity `hobo-ci-owner`** for `hobo ci app create` on your own
   machine: Universal Auth
   ([login endpoint](https://infisical.com/docs/api-reference/endpoints/universal-auth/login)),
   member of `hobo-ci` with **Developer**. Create a client secret with a short
   TTL (an hour) when you need it, and revoke it afterwards.
7. **The relay's entries.** In `hobo-ci` / `prod` / `/hobo-ci-relay`, create the
   entries below except the five App credentials, which step 8 writes.
8. **The GitHub App.** On your machine:

   ```sh
   export INFISICAL_PROJECT_ID=<hobo-ci project id> INFISICAL_ENVIRONMENT=prod \
     INFISICAL_SECRET_PATH=/hobo-ci-relay INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<id>
   read -rs INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET && export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
   hobo ci app create --relay https://<relay-host> --owner-id "$(gh api user --jq .id)"
   ```

   `INFISICAL_TOKEN` (for example from
   `infisical login --method=universal-auth --silent --plain`) works in place of
   the client id and secret. See [`hobo ci app create`](../hobo/CI.md#create-the-hosted-relays-github-app).

## What the relay deployment declares

Plain configuration on the Vercel project, not secrets:

| Variable | Value |
|---|---|
| `HOBO_CI_CONFIG_SERVICE` | `infisical` (`env`, the default, reads the environment instead) |
| `INFISICAL_SITE_URL` | optional; `https://app.infisical.com` if unset |
| `INFISICAL_IDENTITY_ID` | the id of `hobo-ci-relay` |
| `INFISICAL_PROJECT_ID` | the id of `hobo-ci` |
| `INFISICAL_ENVIRONMENT` | `prod` |
| `INFISICAL_SECRET_PATH` | `/hobo-ci-relay` |

`HOBO_CI_CONFIG_SERVICE` is a setting of the relay's Bindle
([`src/bindle.ts`](src/bindle.ts)); the `INFISICAL_*` coordinates belong to the
config-service binding of the relay's Yard ([`deploy/yard.ts`](deploy/yard.ts),
phase 6). The production Camp chooses that binding: it projects
`HOBO_CI_CONFIG_SERVICE=infisical`, `INFISICAL_SITE_URL` and
`INFISICAL_SECRET_PATH`, the Camp adds `INFISICAL_ENVIRONMENT=prod`, and the two
ids are given at deploy time from repository variables. `hobo ci deploy` sets
them on the project for production; nobody types them into Vercel.

## The deploy workflow on `main`

[`.github/workflows/relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)
deploys the relay to production on every push to `main` that changes it, and on
a manual run (Actions → HoBo relay deploy → Run workflow). It never asks anyone
to deploy, and it holds no secret: it signs in to Infisical with the job's GitHub
Actions OIDC token as `hobo-ci-deploy` (step 4 above) and reads `VERCEL_TOKEN`
from the `hobo-ci-deploy` project (step 5), masked in the log.

### Repository variables

Settings → Secrets and variables → Actions → **Variables** (not Secrets: these
are ids and coordinates, and the job reads them as `vars.*`). Until the first
five are set, the job ends with a notice naming the missing ones, and succeeds.

| Variable | Value | Required |
|---|---|---|
| `HOBO_CI_DEPLOY_INFISICAL_IDENTITY_ID` | the id of the `hobo-ci-deploy` identity | yes |
| `HOBO_CI_DEPLOY_INFISICAL_PROJECT_ID` | the id of the `hobo-ci-deploy` project | yes |
| `HOBO_CI_RELAY_INFISICAL_IDENTITY_ID` | the id of the `hobo-ci-relay` identity (the relay's `INFISICAL_IDENTITY_ID`) | yes |
| `HOBO_CI_RELAY_INFISICAL_PROJECT_ID` | the id of the `hobo-ci` project (the relay's `INFISICAL_PROJECT_ID`) | yes |
| `HOBO_CI_RELAY_VERCEL_TEAM_ID` | the Vercel team id, `team_…` | yes |
| `HOBO_CI_DEPLOY_INFISICAL_ENVIRONMENT` | the deploy project's environment | no; `prod` |
| `HOBO_CI_DEPLOY_INFISICAL_SECRET_PATH` | the folder holding `VERCEL_TOKEN` | no; `/` |
| `HOBO_CI_INFISICAL_SITE_URL` | `https://eu.infisical.com` for EU Cloud | no; US Cloud |
| `HOBO_CI_DEPLOY_INFISICAL_AUDIENCE` | the audience the deploy identity expects, if not GitHub's default | no |
| `HOBO_CI_RELAY_URL` | the relay's production origin, for the smoke check | no; the deployment URL, which Deployment Protection may answer 401 |

### What the workflow does, and what stays with the owner

Automated, on every deploy: the setting of the production Camp's non-secret
configuration, the deployment of the pushed commit, the wait for READY, a smoke
check (a 5xx from `/healthz` fails the job; `/readyz` is reported, and answers
`config-unavailable` until the folder above is filled), and the attachment of
the cache. The cache step runs the Vercel CLI (pinned `vercel@65.2.0`) with the
deploy token in its environment: it lists the project's `upstash` resources,
and, when `hobo-ci-cache` is missing, connects the team's resource of that name
for production or provisions one (`vercel integration add upstash/upstash-kv
--name hobo-ci-cache --environment production --no-env-pull --non-interactive`).
Its outcome is in the job summary; a failure there does not stop the deploy.

One-time owner steps, in a browser, besides steps 1–8 above:

1. **Install the Upstash integration on the team** (Vercel accepts an
   integration's terms only from a person: `vercel integration accept-terms`
   needs a terminal). Vercel dashboard → the team → **Integrations** →
   **Browse Marketplace** → **Upstash** → **Install** → accept the terms → choose
   the team. Stop before creating a database: the workflow provisions
   `hobo-ci-cache` on its next run. To do it by hand instead: **Storage** →
   **Create Database** → **Upstash for Redis** → name `hobo-ci-cache`, free plan →
   **Connect Project** → `hobo-ci`, environments Production and Preview.
2. **Team issuer for OIDC** on the `hobo-ci` project (step 3 above): Project →
   Settings → Security → *Secure backend access with OIDC federation* → Team.
3. **Disconnect what the relay no longer uses** once phase 8 has cut over:
   Project → Settings → Integrations → Neon and Turso → Disconnect.

Not provisioned by the workflow, by design: Turso, Vercel Blob and Valkey are
rows of the Yard's catalog that no Camp chooses. Choosing one is a change to
`deploy/yard.ts` (a Camp's `require`), reviewed like any other.

## What the folder holds

One entry per key, named as the relay's environment variable; the loader
refuses a folder holding any other key, and names it (never its value).

| Entry | Required | Written by |
|---|---|---|
| `HOBO_CI_PUBLIC_URL`, `HOBO_CI_SESSION_KEY`, `HOBO_CI_BOOTSTRAP_ACCOUNT_ID`, `HOBO_CI_BOOTSTRAP_TOKEN_SHA256`, `HOBO_CI_CONTROL_TOKENS_JSON`, `HOBO_CI_CONFIG_JSON` (the config document), `CRON_SECRET` | yes | owner, later `hobo ci` |
| `HOBO_CI_INVITATION_EXPIRES_AT`, `HOBO_CI_ONBOARDING_CONTROL_TOKEN`, `HOBO_CI_SANDBOX_ENABLED`, `HOBO_CI_SANDBOX_TEAM_ID`, `HOBO_CI_SANDBOX_PROJECT_ID`, `HOBO_CI_SANDBOX_ISSUER`, `HOBO_CI_SANDBOX_PLAN`, `HOBO_CI_SANDBOX_DOMAINS_JSON` | no | owner |
| `HOBO_CI_SANDBOX_PROXY_TOKEN_KEY` (32 random bytes, base64url: each Sandbox proxy session token is derived from it, so none is stored) | with `HOBO_CI_SANDBOX_ENABLED` | owner |
| `HOBO_CI_GITHUB_APP_ID`, `HOBO_CI_GITHUB_APP_CLIENT_ID`, `HOBO_CI_GITHUB_APP_PRIVATE_KEY`, `HOBO_CI_WEBHOOK_SECRET`, `HOBO_CI_GITHUB_APP_CLIENT_SECRET` | yes | `hobo ci app create` |
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

The constraints are those of the moved `RuntimeBrokerConfig` schema
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
  checked when the organization is created.
- That GitHub accepts a loopback `redirect_url` in an App manifest is assumed
  (tools such as Probot rely on it), not checked here.
- That an Infisical `PATCH` of a missing secret answers 404 (the adapter then
  creates it) follows the API reference; it is not observed here.
