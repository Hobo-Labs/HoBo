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
| 1 | Any store that publishes auth.md with anonymous agent registration | the store's own claim page, opened through `hobo claim open` | designed |
| 2 | HoBo's config-service Worker on a Cloudflare temporary account | Cloudflare's claim page, within 60 minutes | designed |
| 3 | Infisical on the owner's compute fleet, bootstrapped by HoBo | a sealed sign-in, revealed once by `hobo claim open`; finalize revokes HoBo's bootstrap identity | yes |
| 4 | An Infisical Cloud organization the owner already has (attach-only) | the owner's own `infisical login`, for one run | yes |

HoBo routes to the first offer whose evidence is present and whose runtime
binding is built; `--allow-designed` lifts the second gate. Today that makes
self-hosted Infisical the first store the relay can actually use; the
Cloudflare Worker and auth.md stores are provisioned and claimed by the same
command once their runtime binding lands (the amendment says what is built).

### What provisioning creates

Either Infisical offer ends in the same layout, which is what the relay's
loader and the deploy workflow read:

| Project | Environment / folder | Identity | Role | Trusts |
|---|---|---|---|---|
| `hobo-ci` | `prod` / `/hobo-ci-relay` | `hobo-ci-relay` | viewer | the Vercel team issuer: `iss`/discovery `https://oidc.vercel.com/<team-slug>`, `aud` `https://vercel.com/<team-slug>`, `sub` `owner:<team-slug>:project:hobo-ci:environment:production`, claims `owner_id` and `project_id` pinned |
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy` | viewer | GitHub Actions: `iss` `https://token.actions.githubusercontent.com`, `aud` `https://github.com/<owner>`, `sub` `repo:<owner>/<repo>:ref:refs/heads/main` |

The deploy credential has a project of its own so the relay's identity, a
member of `hobo-ci` only, can never read it (Infisical project roles cover the
whole project). Endpoints: `POST /api/v1/admin/bootstrap` (self-hosted only),
`POST /api/v1/projects`, `POST /api/v1/folders`,
`POST /api/v1/projects/{projectId}/identities`,
`POST /api/v1/auth/oidc-auth/identities/{identityId}`, and at finalize
`DELETE`/`GET /api/v1/identities/{identityId}`, from Infisical's OpenAPI
document (read 2026-11-12), pinned by
[`infisical-admin.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json).

The coordinates (the store's origin, both project ids, both identity ids, the
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
job's GitHub Actions OIDC token as `hobo-ci-deploy` and reads `VERCEL_TOKEN`
from the `hobo-ci-deploy` project, masked in the log. A `route` job picks the
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
the cache. The cache step runs the Vercel CLI (pinned `vercel@65.2.0`) with the
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
