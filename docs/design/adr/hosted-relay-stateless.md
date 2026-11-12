---
type: Architecture Decision Record
title: "The Hosted CI Relay Keeps No Durable State"
description: "The hosted CI relay on Vercel becomes a twelve-factor process: config and secrets in a separate service, short-lived job state in a Redis-protocol cache it may lose, Vercel Queues for intake and per-lease steps, GitHub as the system of record. Its database, relay database fleet and Neon broker are removed."
tags: [hobo, design, adr, ci, relay, twelve-factor]
---

# ADR-0179 — The Hosted CI Relay Keeps No Durable State {#adr-0179}

**Status:** Accepted (design; implementation phased); amended 2026-11-11 with
[options routed by budget](#amendment-options-routed-by-budget) and 2026-11-12
with [secret store chosen at deploy, provisioned by claim](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)
and [secretless first](#amendment-secretless-first) (deploy target unchanged, secrets removed or derived, a generic secrets manager, MCP App capture for the remainder). Implemented:
phases 2, 2b, 3, 4a, 4b, 4c (cache-fleet selection by budget), 5 (the
relay's helpers on the cache, offers as provider manifests; provider usage
pulls deferred) and 7 (the PostgreSQL path removed); not yet deployed
**Date:** 2026-11-11
**Supersedes, for the hosted relay:** the PostgreSQL store (`PostgresCiStore`)
as the relay's store, the relay database fleet and store selection, the Drizzle
relay schema and migrations, the Neon-hosted runtime-config broker, and the
plan to move the relay's database to self-hosted Postgres (increment 7 of
[CI Relay Mesh](../ci-relay-mesh.md#increments)).
**Amends:** [`packages/ci/ADR.md`](../../../packages/ci/ADR.md) and
[`packages/ci-gh-actions/ADR.md`](../../../packages/ci-gh-actions/ADR.md) (the
hosted host's store, the control API's configuration writes, and the Station
budget-signal bridge into the hosted relay).

## Context

On 2026-11-10 the hosted relay's Neon Postgres exceeded its plan quota and the
relay answered 503 to every request, GitHub's webhook deliveries included. The
work that followed made the database more available: choosing among attached
stores, a relay database fleet across providers, a Drizzle schema, and a plan
to self-host. Each made the relay operate more infrastructure; none removed
the dependency.

Most relay state does not need to outlive a job. GitHub holds the
authoritative state of every job, and the relay already re-reads it through
REST before it writes. What remains is configuration and secrets, which change
rarely and are written by operators, and counters with a natural expiry.

## Decision

The hosted relay keeps no durable state. In twelve-factor terms:

1. **Config and secrets are a separate service.** First binding: Infisical
   Cloud (free plan; open source, so it can later run on HoBo's own compute).
   *Amended 2026-11-12:* which service is chosen when the deployment runs and
   handed to the owner by claim; Infisical Cloud is attach-only
   ([amendment](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)).
   The relay authenticates with its Vercel OIDC token through Infisical OIDC
   Auth (a machine identity trusting `https://oidc.vercel.com/<team>`, bound to
   project and environment): no secret zero. CI authenticates with GitHub
   Actions OIDC to a separate admin identity. The relay reads config (accounts,
   policy, offers, control-token digests, routing preferences) and secrets (App
   private key, webhook secret, client secret, session key, cron secret,
   onboarding token) read-only and caches them in memory. Secret references use
   the existing `infisical` `SecretRef` scheme. Fallback binding: GCP Secret
   Manager through Vercel OIDC workload identity federation, same port.
2. **No database.** Short-lived per-job state lives in a Redis- or
   Valkey-protocol cache with TTL, compare-and-set and increment: the
   `@hobo/kv-redis-compatible` requirement (`ttl`, `atomicIncrement`,
   `atomicCompareAndSet`). First binding: Upstash Redis free tier through the
   Vercel Marketplace; self-hosted Valkey binds to the same port. As amended
   below, the cache is one of several backends — Upstash, Aiven for Valkey,
   Turso (libSQL), self-hosted Valkey, later Vercel Blob — chosen by budget
   policy, exactly one active at a time. Loss of the
   cache is tolerated: state is rebuilt from GitHub and Vercel by deterministic
   names. The cache command budget is a design constraint, so work is driven by
   queue messages, not polling.
3. **Vercel Queues where they fit:** webhook intake (idempotency key = GitHub
   delivery id; acknowledged to GitHub after enqueue; replaces the inbox),
   per-lease lifecycle steps as delayed messages keyed `${leaseId}:${step}:${n}`
   (replaces scans over all in-flight leases), repair ticks, and retries. Not
   for state reads, compare-and-set, counters, the MCP change feed, config or
   secrets: a queue cannot be read back.
4. **GitHub is the system of record for jobs.** Lease ids are UUIDv5 of
   `repositoryId:jobId:runAttempt` (a requeue generation appended after the
   first), so runner names, bridge run titles and Sandbox names are stable and
   rediscoverable; duplicates collapse.
5. **Mutual exclusion is per key:** a version compare-and-set per lease, a
   job-taken marker (`SET NX` with TTL), a small per-account in-flight index
   for concurrency limits, intent timestamps on the lease record for crash
   recovery, and the queue deadline from the GitHub job's `created_at`. The
   single partition row lock goes away.
6. **Sessions** are encrypted signed cookies; OAuth `state` is single-use
   through `SET NX`.
7. **Budgets** are declared caps; exposure is provider usage pulled on the
   relay's tick plus holds of in-flight leases. No accounting records; overrun
   is bounded by one pull interval. Broker budget-policy accounts stay
   unsupported on the hosted relay, as they already are.
8. **Config is read-only at runtime.** The hosted relay no longer serves the
   policy, providers, signals, observations, rate-observations, quarantine and
   repository-setup write endpoints; `hobo ci` writes config to the config
   service and acts on GitHub directly. Read endpoints stay.
9. **MCP** shows in-flight work only; `wait_for_events` reads a bounded TTL
   change ring and returns a cursor reset when the ring is gone.
10. **Sandbox egress and proxy caps** are counted authoritatively in the
    Sandbox's own proxy VM and mirrored to the cache.
11. **Deployment goes through HoBo:** the relay's Bindle, Yard and Camp declare
    the cache, queue, schedule and config-service bindings; `hobo ci deploy`
    plans from them; a workflow on `main` deploys, authenticating to Infisical
    with GitHub OIDC. No manual deploys.
12. **Pay only for what is used.** Neon and its integration, the Neon broker,
    the relay database fleet, store selection, the
    Drizzle relay schema and migrations, `PostgresCiStore` and its pg-bound
    helper stores, and the box worker's `HOBO_CI_STORE=postgres` option are
    removed. Turso, attached and unused when this was decided, stays as a
    cache-fleet option (amendment below).

Unchanged and out of scope: the compute fleet (mesh, capacity, runner routing
and balancing, NATS mesh state), `SqliteCiStore` for box workers and
`hobo ci serve`, `@hobo/data-postgres` including its fleet module, and the
Broker budget ledger library.

The full design, the table-by-table mapping, the hazards, the cost model and
the eight-phase delivery plan are in
[Hosted CI Relay Without Durable State](../hosted-relay-stateless.md).

## Amendment: options routed by budget

*2026-11-11.* Every option is supported, and HoBo's own capability matching and
budget policy choose among them; the relay dogfoods the routing it sells. Two
independent choices:

1. **Cache fleet** (the relay's state fleet, behind `EphemeralStatePort`; the
   compute fleet is untouched): Upstash Redis (500,000 commands a month free,
   then $0.20 per 100,000), Aiven for Valkey free (no command cap, single node,
   powered off when idle), Turso free (500 million rows read and 10 million
   written a month, blocked when exhausted; bound by `@hobo/provider-turso`),
   self-hosted Valkey (no provider cost), and Vercel Blob (first-party,
   OIDC, compare-and-set through ETags; not built, pricing unverified).
   Vercel Runtime Cache may sit in front as a read-through layer, never for
   exclusion. Exactly one backend is active, because compare-and-set is
   correct only within one; the choice reuses the engine-neutral parts of the
   relay database fleet's policy (`AssignmentReplica`, `resolveAssignment`,
   `decideFleet`), with the assignment log replicated across the cache
   backends through the port's compare-and-set, and those parts move to an
   engine-neutral package. Switching is safe because cache loss is
   tolerated: the new backend starts cold and the relay rebuilds by
   deterministic names.
2. **Lifecycle driver**, a `LeaseLifecycleDriver` port: Vercel Queues
   (delayed messages per lease step), then Vercel Workflows on Vercel's
   managed World (one durable run per job, exactly-once starts by hook token;
   $20 per million events on Pro, about 22 events a job, so about $49 a month
   at 3,700 jobs a day). Chosen per job at admission and sticky for that job,
   so switching never strands work. A self-hosted World is not viable on
   Vercel today (the Postgres World needs a long-lived worker; community
   Worlds do not support `workflow` 5) and stays a future option. The
   Workflows driver needs a Nitro entry or a custom builder in
   `@hobo/ci-vercel` and `workflow` 5.4.0 or later, pinnable from 2026-11-18.

Each option is a provider manifest whose billing lowers into the
`@hobo/pricing` catalog, registered by the deploy; preference is free, then
prepaid, then the cheapest pay-as-you-go; usage is metered per backend and
driver against its allowance; the relay switches before exhaustion, with
hysteresis, under budget caps declared in config. With no cache reachable the
relay keeps serving on a GitHub-only floor that looks a runner up by its
deterministic name before creating one; GitHub's duplicate-name behaviour is
unverified and is tested before the floor relies on it. One more owner action:
create an Aiven free Valkey service and store its connection URL in the config
service (an optional cache-fleet member, not a prerequisite). Details, sources, the cost table at measured volume and the phases
(2b, 4b–4e, 5): [Options routed by budget](../hosted-relay-stateless.md#options-routed-by-budget).

*Phase 4c, implemented.* The engine-neutral parts moved to
[`@hobo/backend-routing`](../../../packages/backend-routing/README.md) (formerly `@hobo/backend-fleet`), which
`@hobo/data-postgres` re-exports. The assignment log is kept in one key of
every cache backend (`ephemeralAssignmentReplica`), the active backend is
read from it by majority, a move is sealed for longer than twice the minute
an instance caches that answer before the target is activated, and the
repair tick routes by budget (`routeFleetByBudget`: switch at 90% projected,
back only below 80%). With no majority the relay refuses admissions
retryably. Details: [Exactly one cache at a time](../hosted-relay-stateless.md#exactly-one-cache-at-a-time).

*Phase 5, implemented.* The repair scanners (missed deliveries, queued jobs)
run on the cache with a lock per scanner and App, cursors and minute
windows; worker health is TTL'd evidence in the cache that reads as
"starting" when missing; OAuth state, sessions and App-installation state
are cache records named by an HMAC under the session key and, where they
hold a credential, sealed under a key derived from it (the browser keeps an
opaque cookie: the session holds a GitHub user token, which §6's signed
cookie would have put in the browser); the owner redeems the invitation in
the config service once and the relay creates no App. The proxy VM is the
authority for its meter: the Sandbox host reads it before stopping the VM,
so a lease rebuilt after a cache loss settles. Every cache backend and
lifecycle driver is a provider manifest in `packages/ci-vercel/offers/`,
lowered into the `@hobo/pricing` catalog, with the `kv.ephemeral-state/v1`
and `lifecycle.lease-driver/v1` profiles; the cache fleet's default offers
come from that catalog, and the start-up log records the driver choice
(Vercel Queues; Workflows not built and not pinnable before 2026-11-18).
**Deferred:** provider usage pulls for budgets (no client for Vercel's usage
API or GitHub's billing usage API exists in the repository), so exposure
stays configured spend plus in-flight holds; Vercel Blob and Queues prices
are unverified. Details: [Phase 5](../hosted-relay-stateless.md#phase-5).

## Amendment: secret store chosen at deploy, provisioned by claim

*2026-11-12.* Decision 1 named a config service, Infisical Cloud, that an
owner had to set up by hand: an organization, two projects, three machine
identities, a Vercel token and five repository variables. That checklist is
withdrawn. Agent authentication with a claim replaces it.

1. **The store is a capability, chosen when the deployment runs.** The relay
   needs `secrets.config-service/v1`. HoBo routes it when `hobo ci deploy` (or
   `hobo deploy` for an app whose Yard binds the capability) runs, through
   `hobo ci secret-store plan|provision`
   ([`@hobo/secret-store-claim`](../../../packages/secret-store-claim/README.md)):
   hard gates on evidence gathered at that moment, then HoBo's preference
   order. Nothing is pre-provisioned by hand. **Nothing is stored in Vercel
   environment secrets, and nothing in GitHub secrets or variables.** The
   chosen store's coordinates (origin, project ids, identity ids, Vercel team
   id; no credential) are committed as `deploy/secret-store.binding.json`, the
   `SecretStoreBinding` record, which `hobo ci deploy` and the deploy workflow
   read. The Yard's config-service row names the capability and that file and
   asks for three inputs (`INFISICAL_SITE_URL`, `INFISICAL_IDENTITY_ID`,
   `INFISICAL_PROJECT_ID`); it no longer hard-codes Infisical Cloud.
2. **Offers, in preference order** (`DEFAULT_SECRET_STORE_OFFERS`; facts read
   2026-11-12, ranking input only):

   | # | Offer | Agent auth | Owner's claim | Cost | Availability | Relay binding |
   |---|---|---|---|---|---|---|
   | 1 | Any store that publishes auth.md with anonymous agent registration | `@hobo/auth-md` anonymous registration | the store's claim page, sealed, opened by `hobo claim open` | the store's | the store's | designed |
   | 2 | HoBo's config-service Worker on a Cloudflare temporary account | Cloudflare temporary account (proof of work; the owner accepts Cloudflare's Terms and Privacy Policy first) | Cloudflare's claim URL, sealed; **within 60 minutes or Cloudflare deletes the account** | none while temporary; the owner's Workers plan after | account creation is rate-limited; the relay depends on Cloudflare | designed |
   | 3 | HoBo-hosted Infisical (open source, self-hosted) on the owner's compute fleet | `POST /api/v1/admin/bootstrap` on a fresh instance | a sealed sign-in revealed once by `hobo claim open`; finalize revokes HoBo | no vendor fee; Infisical, PostgreSQL and Redis on the owner's hosts | **the relay's config availability becomes that host's** | built |
   | 4 | An Infisical Cloud organization the owner already has | none: attach-only | the owner's own `infisical login`, for one run | Infisical's free plan | Infisical Cloud's | built |

   The routing gate that passes over 1 and 2 today is the relay's runtime
   binding, not preference: the relay's loader reads Infisical, so
   `selectSecretStore` skips an offer whose binding is designed unless
   `--allow-designed` is given, and says why in the plan. The offer table
   does not change when the Worker lands; the gate opens.
3. **Why this order, and the vendor evidence.** Infisical Cloud cannot be
   created by an agent: `infisical.com/auth.md` answers its agent 404 ("There
   is no agent-readable page"), `app.infisical.com/.well-known/*` serve the
   SPA, there is no RFC 8414 metadata and no dynamic or client-ID-metadata
   registration (`/api/.well-known/oauth-authorization-server` is 404); OAuth
   applications are registered by an admin, and delegated tokens cannot create
   organizations, machine identities or roles; every workload auth method
   (OIDC, JWT, SPIFFE, AWS/GCP/Azure/OCI/Alibaba, Kubernetes, TLS, Universal)
   authenticates an identity that already exists (all checked 2026-11-12). So
   Infisical Cloud is attach-only, and an Infisical HoBo provisions is
   self-hosted, where the
   [automated bootstrap](https://infisical.com/docs/self-hosting/guides/automated-bootstrapping)
   returns an admin user, an organization and an instance-admin machine
   identity with a Token Auth token. Cloudflare temporary accounts are
   production today and are agent authentication with a claim
   ([Claim deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/));
   Cloudflare's own `auth.md` says auth.md registration is not live there and
   points to them. auth.md stays first and generic: Resend, Firecrawl and
   WorkOS publish it today; Infisical, Doppler, 1Password, Bitwarden, Akeyless,
   Upstash, Turso and Vercel do not, and a secret manager that adopts it is
   picked up by discovery with no change here. Neon's claimable Postgres
   (`neon.com/auth.md`) is agent auth with a claim too, but a database, not a
   secret manager: it is relevant only as the PostgreSQL a self-hosted
   Infisical needs.
4. **The Cloudflare offer, honestly against a dedicated secret manager.** A
   temporary account holds Workers, KV, D1, Durable Objects, Queues and
   Hyperdrive; Secrets Store and Worker secret bindings are not listed as
   supported. The design is a small HoBo Worker: values envelope-encrypted
   (AES-GCM) in a Durable Object; the root key a Worker secret binding, which
   provisioning probes and, if the temporary account refuses it with an
   authorization error, treats as the offer being unavailable (fail closed,
   route on), never as a key stored beside the data; reads authorized by the
   relay's Vercel OIDC token (issuer, audience, subject and pinned
   `owner_id`/`project_id`, as Infisical's OIDC Auth does), writes by the
   deploy workflow's GitHub OIDC token. That is agent-auth-and-claim with no
   new vendor, and costs nothing while temporary. It is also HoBo writing a
   secret manager: crypto, authorization, audit, rotation and versioning that
   Infisical already has and HoBo would have to build and review. Claiming
   gives the owner the account and its data; the platform keeps no access, so
   later writes need the owner's own Cloudflare authorization. Built: the
   account, its consent, proof of work and claim (`provisionCloudflareTemporaryStore`
   over `@hobo/provider-cloudflare`'s temporary-account Yard). Designed: the
   Worker, its upload, and the relay's loader for it; until then the temporary
   token is destroyed when provisioning returns.
5. **Claim, expiry and threat model** (against
   [the anonymous-claim threat model](../anonymous-claim-threat-model.md)).
   Every claim is a `@hobo/claims` bundle on the deployment's claim journal,
   driven by `hobo claim status|open|finalize`; one item, `secret-store`.
   - *Claim URL replay.* A claim URL or sign-in goes straight into the
     owner-only, encrypted one-time action store, bound to tenant, project,
     session and the item's provider, single-use, expiring at the provider's
     deadline (Cloudflare's `claim.expiresAt`; auth.md's `expires_at`; 24
     hours for a self-hosted sign-in). `provision` never prints it; the
     owner reveals it with `hobo claim open` in their own terminal; the skill
     forbids the agent to run that. Events, the plan, the binding and errors
     carry references only, and `assertNoSecrets` guards the journal.
   - *Confused deputy.* Redemption is scoped by audience: one provider's item
     cannot redeem another's action. Completion is verified through the
     provider, never by a redirect: for self-hosted Infisical, finalize deletes
     HoBo's bootstrap identity with its own token and passes only on
     Infisical's 401 for that token. Cloudflare's and auth.md's verification
     is designed; finalize refuses those items rather than pass them.
   - *Credentials HoBo must not keep.* Cloudflare's temporary token: destroyed
     at once (designed: used once for the Worker upload, then destroyed).
     Infisical's instance-admin token: sealed under a separate audience only
     finalize redeems, and revoked there. The bootstrap admin password: sealed
     into the claim and never printed, but HoBo generated it, so the owner is
     asked to change it and turn on MFA; Infisical exposes no read of that to
     an identity HoBo keeps, so this one step is asked, not observed.
   - *Orphans and expiry.* Cloudflare deletes an unclaimed account after 60
     minutes, so the skill leads with that deadline. A self-hosted store
     whose claim expires keeps running on the owner's compute (their cost);
     cleanup on a durable timer is designed. Bundles are `best-effort-saga`,
     never called atomic.
6. <a id="the-deploy-credential"></a>**The deploy credential.** Checked
   2026-11-12 against Vercel's
   [Claim Deployments](https://vercel.com/docs/deployments/claim-deployments)
   and [deploy without logging in](https://vercel.com/docs/deployments/deploy-without-logging-in):
   `vercel deploy --temporary` always creates a new project, always targets
   production, refuses to run in CI or in a directory linked to a project, and
   its claim moves the whole project to the claimer's team; the platform flow
   (`POST /projects/:idOrName/transfer-request`, a code valid 24 hours, the
   `vercel.com/claim-deployment?code=…` page) needs a token on the source
   team. **Neither can deploy into an existing project in the owner's team.**
   So: a relay with no project yet is first deployed with `--temporary` from
   the owner's machine and its project claimed by the owner (one click); a
   relay whose project exists keeps it. For deploys from `main`, Vercel offers
   no way for an agent to obtain a token for a team it does not own, so the
   token is minted once in the owner's own `vercel login` session (a claim
   step the skill drives) and written only into the store's `hobo-ci-deploy`
   project, which the relay's identity cannot read. Designed, not built: no
   Vercel API write is made from this change, and the token-creation request
   is unverified.
7. **The GitHub App.** GitHub's manifest flow ends in one browser click by
   design. `hobo ci app create` drives it; the skill presents it as a claim
   step (what the owner approves, then wait), not a checklist item. Its
   credentials go to the chosen store.
8. **The deploy workflow** gates on the committed binding (absent: a notice,
   success), reads no repository variable about the relay, signs in to the
   store with GitHub OIDC as `hobo-ci-deploy`, and routes its runner through
   the `route` job as `hobo-ci.yml` does, so a busy fleet no longer holds it
   (its first run on `main` waited 48 minutes for a `hobo-trunk` slot).

*Implemented with this amendment:* the records (`SecretStoreOffer`,
`SecretStoreEvidence`, `SecretStoreSelection`, `SecretStoreBinding`, protobuf
and CUE with fixtures), the routing seam, the auth.md path (discovery,
anonymous registration, claim initiation, sealed link), the Cloudflare
temporary-account path (consent, proof of work, sealed claim URL), the
self-hosted Infisical path (bootstrap, project, folder, identities, OIDC
trust, sealed sign-in, finalize that revokes HoBo), the attach-only path,
`hobo ci secret-store plan|provision`, finalize's verifier for self-hosted
Infisical, `hobo ci deploy` reading the binding, the workflow gate and
routing, and the `hobo-deploy` agent skill; all against local stand-ins and
the pact mock of Infisical's admin API. *Designed only:* the config-service
Worker and the relay's loader for it, an auth.md store's runtime binding, the
Yard placing Infisical with PostgreSQL and Redis on the compute fleet (the
packs `pack-postgres-oci` and `pack-valkey-oci` exist; an Infisical image is
not pinned by digest, so no Infisical pack is added), the Vercel deploy-token
claim step, and verification of Cloudflare and auth.md claims. Details:
[Secret store chosen at deploy](../hosted-relay-stateless.md#secret-store-chosen-at-deploy).

## Amendment: secretless first

*2026-11-12, later the same day, from the owner's direction:* "Make sure our
HoBo deployments are going where they have historically gone"; "you're
requiring too many secrets where secretless auth is preferred"; "update the
infisical requirement to be a generic secrets manager requirement". It
narrows the previous amendment in four ways.

### The deploy target does not change

The relay deploys to the owner's Vercel project `hobo-ci`
(`prj_J5YGgyIQm09MKI0uqyi0hl9cYrBO`, team `tyler-r-kendricks-projects`,
`team_BRBUnG6uGhSsVV3EG5GFV3FM`), placed by the Yard `hobo-ci-relay`
(`packages/ci-vercel/deploy/yard.ts`), **through Vercel's Git integration**:
a push to `main` builds and promotes it, as every production deployment of
`hobo-ci` so far has been (its latest, `dpl_9WSb8PKdF666xLVczNBabrjcoTEp`,
carries `githubOrg: Hobo-Labs`, `githubCommitRef: main` and the
`hobo-ci-git-main-…` alias; read with the Vercel MCP, 2026-11-12). No
Cloudflare Worker, no new target. The Cloudflare temporary-account Worker
store (offer 2) is an experiment on another branch, not the relay's store.

### Secrets that no longer exist

Every secret the relay or its deploy named, and what it became. Vendor facts
were read on 2026-11-12 from the sources linked.

| Secret | Now | How, and why |
|---|---|---|
| `VERCEL_TOKEN` (deploy) | **removed** | Vercel's Git integration deploys; the relay reads its store's coordinates (ids, no credential) from the committed `deploy/secret-store.binding.json` bundled with the function (`includeFiles`), so no Vercel environment variable is set through the API. The workflow finds the deployment through GitHub's Deployments API with its own `GITHUB_TOKEN` ([Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github): "uses the deployment API"). **No Vercel API write remains** in the default path; `hobo ci deploy` stays for a manual deploy. |
| Store access, relay runtime | **none stored** | OIDC Auth with the relay's Vercel OIDC token (unchanged). |
| Store access, CI | **none stored** | OIDC Auth with the job's GitHub Actions token, as `hobo-ci-writer` (write-capable: Advanced+ custom create/edit-only on the relay folder, or **Free** built-in **Member** on attach — see `packages/ci-vercel/CONFIG-SERVICE.md`), recorded in the binding's `deployIdentityId`. The separate deploy project is now optional (`deployProjectId` may be empty). |
| `HOBO_CI_GITHUB_APP_PRIVATE_KEY`, `HOBO_CI_WEBHOOK_SECRET` | **kept, never human-handled** | Generated by GitHub in the App-manifest conversion, which needs no authentication and is valid for one hour ([REST: Create a GitHub App from a manifest](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest); [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)). `hobo ci app create --via-workflow` hands the one-time code to the deploy workflow's `app-credentials` job (on stdin to `gh workflow run`), which masks it, converts it, verifies the App and writes the credentials as `hobo-ci-writer` (`hobo ci app deposit`). The owner's one browser click stays. GitHub signs webhooks with a shared secret, so the webhook secret cannot be secretless. |
| `HOBO_CI_GITHUB_APP_CLIENT_SECRET` | **kept, never human-handled; removal designed** | The relay's onboarding uses the web flow, whose token exchange requires the client secret; the **device flow needs only `client_id`** (it must be enabled in the App's settings; [user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). Moving onboarding to the device flow drops this secret; that UX change is not built here. Until then it is deposited with the key. |
| `HOBO_CI_SESSION_KEY`, `HOBO_CI_SANDBOX_PROXY_TOKEN_KEY`, `CRON_SECRET` | **derived** | HKDF-SHA256 of the App private key (salt `hobo-ci/relay-root/v1`, info = the setting's name; `packages/ci-vercel/src/relay-derived-keys.ts`). `CRON_SECRET` is not a Vercel cron secret: the repair tick is a Vercel Queues schedule (`vercel.json` `schedules`), and queue consumers are private ("air-gapped with no public URL", [Queues concepts](https://vercel.com/docs/queues/concepts)); the name only authenticates the handoff from an older deployment to `/internal/queue-wakeup`. Rotating the App key rotates all three (sessions re-sign-in, proxy tokens re-issue, a handoff in flight is redelivered). A value stored under the name still wins. Authenticating the handoff with the sender's Vercel OIDC token instead is the next step (designed). |
| `HOBO_CI_BOOTSTRAP_TOKEN_SHA256`, `HOBO_CI_CONTROL_TOKENS_JSON`, `HOBO_CI_ONBOARDING_CONTROL_TOKEN` | **kept; replacement designed** | The store holds digests, not bearers, but operators hold bearer tokens. Designed: authorize the control API by GitHub identity (the operator signs in with GitHub through the App; authorized by repository admin role) and GitHub Actions OIDC for automation (the relay already verifies GitHub OIDC tokens, `createGithubOidcVerifier`). Not built here. |
| Cache credentials | **none by default** | Vercel Blob over OIDC needs only `BLOB_STORE_ID` (the SDK reads `VERCEL_OIDC_TOKEN`; [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)); `@hobo/provider-vercel-blob` already prefers OIDC. Upstash/Turso tokens are Marketplace-managed environment, optional, never human-entered. The workflow no longer provisions Upstash. |
| `VALKEY_URL`, `TURSO_AUTH_TOKEN` (not integration-managed) | **the only captures left** | Optional third-party cache members with no workload identity. Captured by the MCP App below, only if the owner adds one. |

**On the default path, the owner handles zero secret values.**

### A secrets manager, not Infisical

The requirement is the capability `secrets.config-service/v1` behind the
`SecretsPort`; Infisical is one provider of three. What each offers a
workload, checked 2026-11-12:

| Provider | Workload sign-in | Relay runtime reads | Adapter |
|---|---|---|---|
| Infisical | OIDC Auth with any OIDC issuer, Vercel and GitHub Actions included ([OIDC Auth](https://infisical.com/docs/documentation/platform/identities/oidc-auth)) | **yes, secretless** | `@hobo/adapter-infisical` (HTTP API) |
| 1Password | Service-account or Connect token. Workload identity ("brokered access", public preview, Business) federates GitHub Actions and custom OIDC but the workflow still holds an **integration key**, and Vercel is not listed ([brokered access](https://www.1password.dev/brokered-access)) | **no**: a token would have to live in Vercel env or GitHub secrets, which this ADR forbids | `@hobo/adapter-1password` (official SDK client, injected) |
| Bitwarden Secrets Manager | Machine-account access token (expiry "Never" by default); no OIDC federation documented ([access tokens](https://bitwarden.com/help/access-tokens/)) | **no**, same reason | `@hobo/adapter-bitwarden` (official SDK client, injected) |

**Infisical Cloud with OIDC Auth is the default** (the owner confirmed it on
2026-11-12): offer `infisical-cloud-attach` is now preference 1 and needs no
token at all (the owner works only in the web app; `hobo ci secret-store
provision` without `INFISICAL_TOKEN` answers with the dashboard steps and
`connect`). Self-hosted Infisical (2, chosen by naming `--fleet-host`),
auth.md (3) and the Cloudflare Worker (4, an experiment) are not the default.
The owner also found the Bitwarden CLIs unusable from a cloud agent (`bw`
needs a typed master password; `bws` only an access token), which matches
the documentation above.

The routing policy ranks secretless first: every offer now records
`provider` and `runtimeAuth` (`workload-identity` | `stored-token`), the
offers gain `1password-attach` and `bitwarden-attach`, and
`selectSecretStore` never routes the relay's runtime store to a
`stored-token` offer, `--allow-designed` or not; the plan says why in plain
words ("the relay would need a stored 1password token…"). 1Password and
Bitwarden serve the owner's side: the owner's own vault, the agent's tools
(the Anthropic-verified **1Password Claude Code plugin**, whose MCP server
"only sees secret names"; the `op` CLI; Bitwarden's `bws` CLI), and as a
`SecretsPort` the owner can point HoBo at on their machine.

The `hobo-deploy` skill starts from the default, which needs nothing
installed. When the owner asks for another manager it detects what the agent
has (`infisical`, `op`, `bws` on the PATH; an Infisical, 1Password or
Bitwarden MCP server or plugin among its tools) and suggests installing the
owner's choice with the vendor's official path: Infisical CLI
(`brew install infisical/get-cli/infisical` or `npm i -g @infisical/cli`)
and MCP server (`@infisical/mcp`); 1Password CLI (`op`) and Claude Code
plugin (`/plugin marketplace add 1Password/1password-claude-plugin`, then
`/plugin install 1password@1password`); Bitwarden Secrets Manager CLI
(`bws`, from `bitwarden/sdk-sm` releases). It says plainly that only
Infisical can be the relay's runtime store without a stored token.

### Deploy secrets captured by an MCP App

For what genuinely cannot be secretless (today: an optional Valkey URL or a
Turso token not managed by the Marketplace), the agent calls
`capture_secret` on `hobo-mcp`; the value never enters the model's context,
the transcript, a tool result, a log, a file or an environment dump:

- *MCP Apps host* (extension `io.modelcontextprotocol/ui`, specification
  2026-01-26, built against the published types of
  `@modelcontextprotocol/ext-apps` 2.0.4 and the spec text, read
  2026-11-12): `capture_secret` carries `_meta.ui.resourceUri` →
  `ui://hobo/secret-capture` (`text/html;profile=mcp-app`, empty CSP domain
  lists). The form seals the value in the browser (ECDH-ES on P-256,
  HKDF-SHA256, AES-256-GCM, the ticket id and name as associated data) to a
  key pair that exists only in the MCP server process, and calls
  `submit_secret_value` through the host. That tool's `_meta.ui.visibility`
  is `["app"]` (the spec requires hosts to keep it out of the agent's tool
  list), and it is not listed at all to a host without MCP Apps. The host
  relays, and may log, ciphertext only. The form never sends `ui/message` or
  `ui/update-model-context`.
- *Results* are a ticket, then `{name, stored: true, ref}`; refusals carry a
  code and a reason (too short, wrong characters, wrong format, the store's
  error code), never the value. In the server the value is a
  `CapturedSecret` that prints `[redacted secret]`. Records:
  `packages/mcp/data-models/secret_capture.proto` + `.cue`, closed CUE
  definitions; pact `secret-capture-mcp-app.pact.json`.
- *Fallback, a host without MCP Apps.* MCP 2025-11-25 forbids form-mode
  elicitation for secrets and provides URL mode for this case: a client
  that declared `elicitation.url` gets `URLElicitationRequiredError`
  (-32042) naming a page the MCP server serves on `127.0.0.1` (Host and
  Origin checked, a one-time token in the URL fragment, a per-response CSP
  nonce, `no-store`, `no-referrer`); `notifications/elicitation/complete`
  follows the write. A client with neither gets the page's address and an
  instruction to have the owner open it. Never a request to paste a value
  into the chat.
- *What the model can still see:* the ticket id, the public key and, on the
  fallback, the page's address. They grant no read. An agent that ignored
  its instructions could submit a value of its own (integrity, not
  confidentiality); captures are single-use, expire in 10 minutes and close
  after five refusals.
- *How the MCP server may write.* Infisical OAuth applications offer only
  `secrets:read` (no write scope;
  [authorization code](https://infisical.com/docs/documentation/platform/oauth-applications/authorization-code));
  the CI writer's GitHub OIDC identity cannot be used from a local process
  without passing the value through a workflow input. So the remainder is
  written with a **one-use Universal Auth client secret** of a dedicated
  `hobo-secret-writer` identity (create/edit only), created by the owner
  with *Max Number of Uses* 1 and a TTL of minutes, typed into the same form,
  spent by one login; the access token lives at most 15 minutes in the
  server's memory and is revoked (`POST /api/v1/auth/token/revoke`). This is
  the one human-typed credential left, and only when the owner adds an
  optional third-party cache member.

### Connecting the store, and verifying it by name

Infisical Cloud has no agent signup or claim, so the `hobo-deploy` skill
walks the owner through the dashboard one step at a time, every value
prefilled: project `hobo-ci` (folder `/hobo-ci-relay`, `prod`);
`hobo-ci-relay` with OIDC Auth trusting Vercel (issuer and discovery
`https://oidc.vercel.com/tyler-r-kendricks-projects`, subject
`owner:tyler-r-kendricks-projects:project:hobo-ci:environment:production`,
audience `https://vercel.com/tyler-r-kendricks-projects`, `project_id` and
`owner_id` pinned), Viewer; `hobo-ci-writer` with OIDC Auth trusting GitHub
Actions (`https://token.actions.githubusercontent.com`, subject
`repo:Hobo-Labs/HoBo:ref:refs/heads/main`, audience
`https://github.com/Hobo-Labs`), a write-capable project role (Advanced+
custom create/edit-only, or Free **Member** when attach has no custom roles).
`hobo ci secret-store connect` records the ids. Verification is by identity
name: `hobo-ci-writer` in the deploy workflow's *Verify the secret store
connection* step (`hobo ci secret-store verify`: GitHub OIDC sign-in, then
revoke; does **not** assert Infisical role shape); `hobo-ci-relay` by
`/readyz` after Vercel deploys (or `verify` wherever `VERCEL_OIDC_TOKEN` is
present).

*Built with this amendment* (against fakes and pact mocks only): the
derived keys and the committed-coordinates source in `@hobo/ci-vercel`; the
workflow without a Vercel token, with the verify step and the
`app-credentials` job; `hobo ci app create --via-workflow` and `hobo ci app
deposit`; `hobo ci secret-store connect|verify`; `@hobo/adapter-1password`
and `@hobo/adapter-bitwarden`; `provider`/`runtimeAuth` routing in
`@hobo/secret-store-claim`; `signIn`, `revoke` and project-scoped clients in
`@hobo/adapter-infisical`; the MCP App, its fallback and sealing in
`@hobo/mcp`, wired into `hobo-mcp`; the rewritten `hobo-deploy` skill.
*Designed, not built:* the device flow (drops the client secret), GitHub
identity for the control API (drops the control tokens), the OIDC-signed
queue handoff. *Unverified:* no MCP Apps host has rendered the form; no
client has opened the URL elicitation; no request was made to Infisical,
1Password, Bitwarden, GitHub or Vercel beyond the read-only Vercel MCP calls
above; Vercel's GitHub Deployments environment name for `hobo-ci` is matched
loosely (`production` and `hobo-ci`); whether connecting a Blob store today
also adds `BLOB_READ_WRITE_TOKEN` to the project (the relay does not need
it; remove it if present).

## Alternatives considered

- **Self-hosted Postgres** (the previous plan). Removes the vendor quota, keeps
  the dependency, and adds a server to run, back up and upgrade.
- **The relay database fleet.** Survives one provider's quota at the cost of a
  writer register, replication and failover, all to keep state that GitHub
  already holds.
- **NATS JetStream as the relay's store.** The compute fleet's mesh uses it;
  for a Vercel function it means hosting a quorum cluster, which is neither
  free nor infrastructure-free.
- **Vercel Edge Config (now Global Config).** Read-optimised configuration
  written through the API with a Vercel token; no runtime writes, so no
  per-job exclusion. It remains an optional configuration source.
- **Vercel Blob as the only store.** Superseded by the amendment: Blob's
  conditional writes (`ifMatch`, non-overwriting `put`) make it a feasible
  cache-fleet backend, once built and passing the conformance suite, but not
  the sole one.
- **Redis Cloud free.** 30 MB and 100 operations a second, and TLS on the free
  database unclear.
- **Valkey hosted on Vercel.** Daemons accept no inbound HTTP or TCP;
  container services are HTTP-only, autoscaled and scale to zero after five
  idle minutes; a daemon's memory alone would cost about $15.50 a month for
  1 GiB.

## Consequences

- The relay no longer fails on its own: with GitHub up and the cache empty it
  rebuilds; with the cache down it refuses new admissions and keeps no state
  that could be corrupted.
- When GitHub Actions is down nothing can run regardless. Persisted state never
  bought availability for GitHub-triggered work; the cache buys resilience to
  dropped webhooks, REST errors and restarts.
- Job history is GitHub's. The relay keeps logs and a short change ring, not a
  journal. `GET /v1/accounts/self/leases` and MCP show in-flight work only.
- Configuration changes go through `hobo ci` and the config service, with the
  config service's own versioning; the relay cannot be reconfigured over HTTP.
- Budget enforcement is approximate by one pull interval, and priced offers
  pause while the cache is being rebuilt.
- ~~Operators make three one-time moves~~ (withdrawn 2026-11-12): the owner
  makes no setup moves. They take the store by claim when the deployment runs,
  approve the GitHub App's manifest page, and sign in to Vercel once for the
  deploy token; the `hobo-deploy` skill surfaces each when it is needed
  ([amendment](#amendment-secret-store-chosen-at-deploy-provisioned-by-claim)).
  Under [secretless first](#amendment-secretless-first) the owner handles
  no secret value on the default path: the skill walks them through the
  secrets manager's OIDC trust one step at a time, GitHub's App credentials
  go straight to the store, and the few optional remainders are typed into
  the HoBo capture form, never into the chat.
- Many files and tests are deleted in phase 7 (done: the
  [itemized list](../hosted-relay-stateless.md#phase-7-removals)); the package
  READMEs' superseded sections went with them.
