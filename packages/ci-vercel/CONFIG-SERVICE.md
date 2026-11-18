# The relay's config service

The hosted relay reads its configuration from an owner-selected service using
a workload identity. The production runtime currently supports Infisical OIDC;
HoBo's owner store may use any of the supported owner-store providers. Automatic
provisioning and verification of the scoped relay identity is not yet complete.

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

## Selecting the relay connection

The managed delivery path reads a scoped runtime identity from the owner's
selected private session and checks it against the selected Vercel target before
creating a production deployment. It supplies the runtime settings only to that
deployment. A missing, invalid, or mismatched connection prevents production
delivery. The HoBo setup ceremony must establish the store, workload identity,
and target trust before production can be ready; that provisioning is not yet
implemented. The legacy store connect and provision commands refuse rather than
writing owner coordinates into the repository.

The production relay uses `HOBO_CI_CONFIG_SERVICE`, `INFISICAL_SITE_URL`,
`INFISICAL_PROJECT_ID`, `INFISICAL_IDENTITY_ID`, `INFISICAL_ENVIRONMENT`, and
`INFISICAL_SECRET_PATH`. Their values come from the private owner session and
the selected production Yard, not a repository binding.

### What the workflow does and the claim steps the skill drives

The workflow starts pinned-source delivery. Provisioning and verification of
the owner's scoped runtime identity are still required before production can
be delivered.

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
