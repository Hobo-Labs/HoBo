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
  manifest conversion straight into the store (the one-time code crosses as the
  required `HOBO_APP_MANIFEST_CODE` secret, never a workflow input, then the
  `app-credentials` job runs `hobo ci app deposit` as `hobo-ci-writer` over
  GitHub OIDC); the cache's
  default member is Vercel Blob over OIDC. The amendment's table lists every
  secret, what it became and the vendor evidence.
- **Coordinates only in the owner's store.** The store coordinates (project
  and deploy project ids, the relay, writer and reader identity ids, the Vercel
  team id, the OIDC subjects and the claim bundle id) are the owner's private
  settings. They live only in the owner's own secret store, as the
  `HOBO_CI_SECRET_STORE_BINDING` entry, which HoBo reads and writes through the
  owner store session (HoBo MCP's `choose_secret_store`). They are never
  committed, printed, put in a document or pull request, set as an environment
  variable or Actions secret, or asked for in a chat. In production
  (`VERCEL_ENV=production`), the loader reads the
  store's origin, project, environment, folder and the relay's identity from
  `deploy/secret-store.binding.json` inside the function bundle
  (`vercel.json` `includeFiles`). That file exists only in a build HoBo makes:
  `hobo ci deploy --build prebuilt` writes those six fields from the owner store
  session just before `vercel build`, and removes the file once the build is
  staged. The path is ignored by git, and `secrets:guard` rejects a commit of
  it. A command that needs the coordinates without an owner store session
  stops with `HOBO_CI_SECRET_STORE_SESSION_REQUIRED`. The loader never reads a
  coordinate from the environment: `HOBO_CI_CONFIG_SERVICE=infisical` without
  the bundled file fails, and a `--build git` production deploy, which could
  carry none, is refused (`HOBO_CI_DEPLOY_PRODUCTION_NEEDS_PREBUILT`).
- **Connecting** (once): the `hobo-deploy` skill walks the owner through the
  dashboard one step at a time, every value prefilled: projects `hobo-ci`
  (folder `/hobo-ci-relay`, `prod`) and `hobo-ci-deploy` (`prod`);
  `hobo-ci-relay` with OIDC Auth trusting Vercel (issuer
  `https://oidc.vercel.com/<team-slug>`, subject
  `owner:<team-slug>:project:hobo-ci:environment:production`,
  audience `https://vercel.com/<team-slug>`, `project_id` and
  `owner_id` pinned), Viewer, in `hobo-ci`; `hobo-ci-writer` with OIDC Auth
  trusting GitHub Actions, create/edit, in `hobo-ci`; and
  `hobo-ci-deploy-reader` with OIDC Auth trusting GitHub Actions, read-only
  Viewer, in `hobo-ci-deploy` only. The writer job uses protected GitHub
  environment `hobo-ci-app-credentials`; the deploy job uses
  `hobo-ci-deploy`. Their respective OIDC subjects end in
  `:environment:hobo-ci-app-credentials` and `:environment:hobo-ci-deploy` after
  GitHub's immutable repository prefix. Both trusts pin `repository_id`,
  `repository_owner_id`, that distinct `environment`, and `ref`
  `refs/heads/main`. The reader pins both `workflow_ref` and
  `job_workflow_ref` to
  `Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main`. The
  writer pins `workflow_ref` to
  `Hobo-Labs/HoBo/.github/workflows/app-credentials.yml@refs/heads/main` and
  `job_workflow_ref` to
  `Hobo-Labs/HoBo/.github/workflows/relay-deploy.yml@refs/heads/main`.
  `job_workflow_ref` identifies the called implementation; `workflow_ref` pins
  the top-level caller. `app-credentials.yml` is the only supported reusable
  caller of the writer job. This caller split is **built, not proven**: link
  its first successful run whose accepted writer token carries these two
  workflow claims. The writer's audience is `https://github.com/Hobo-Labs`;
  the reader's is `https://github.com/Hobo-Labs/hobo-ci-deploy-reader`. Audience is
  caller-selected, so the environment and workflow claims—not the audience—keep
  a reader-eligible job from authenticating as the writer. (**Connected:** Tyler
  approved using built-in project **Member** (formerly Developer) for
  `hobo-ci-writer` on `hobo-ci` instead of a custom create/edit-only role.
  Infisical Cloud **Free** has no custom project roles ([pricing](https://infisical.com/pricing) — “Custom roles, multi-role, temporary access” on **Advanced** and up; checked 2026-11-12). **Member** is read/write on secrets across all project environments ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12). That residual applies only to the writer: Member is not an acceptable role for `hobo-ci-deploy-reader`.) Then:

  The owner runs `hobo ci secret-store connect --cwd packages/ci-vercel --repo
  Hobo-Labs/HoBo` in their own terminal, with their secret store connected
  through HoBo, passing the dashboard ids as its options (`--project-id`,
  `--deploy-project-id`, `--relay-identity-id`, `--deploy-identity-id`,
  `--deploy-credential-identity-id`, `--team`). An agent never asks for these
  ids, never puts them in a command it runs, and never repeats them. `connect`
  writes them to the owner's store as `HOBO_CI_SECRET_STORE_BINDING`; its
  result names the identities, never their ids, subjects or claims.

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
  audience (`PATCH /api/v1/auth/oidc-auth/identities/{id}`, no new identity).
  The binding is unchanged if either update fails. If reader repair succeeds and
  writer repair fails, the reader stays repaired and the error names both
  outcomes; re-running the idempotent repair completes the writer. Without the
  owner's Infisical sign-in, `connect` says which identities still need their
  trust, without showing the subjects or claims, and preserves an existing
  pending or claimed state. When `verify` is denied with a
  token whose `sub` differs from that subject (or is immutable while no subject
  was recorded), its failure says so and names this repair.

- **The remainder.** Only an optional third-party cache credential
  (`VALKEY_URL`, a `TURSO_AUTH_TOKEN` the Marketplace does not manage) is
  ever typed by a person, into the HoBo MCP App (`capture_secret` on
  `hobo-mcp`), never into the chat; it goes sealed from the form to the MCP
  server to the store. See [`@hobo/mcp`](../mcp/README.md#secret-capture-mcp-app).
- **Verifying**, by identity name: `hobo-ci-deploy-reader` in the deploy
  workflow's *Verify the secret store connection* step (`hobo ci secret-store
  verify --identity reader`) must read `VERCEL_TOKEN` without logging it, have
  exactly Viewer, and receive HTTP **403** for relay-folder listing and direct
  token read plus HTTP **404** for relay-project membership. `hobo-ci-writer` is
  verified separately by `verify --identity writer` in `hobo-ci-app-credentials`:
  it must sign in and receive the same read/membership refusals for the deploy
  project. The relay identity receives those checks wherever its Vercel token is
  available and is also checked by `/readyz` after deployment. Verification never
  writes a probe secret, and every issued session is revoked. An unfiltered
  `verify` requires every applicable identity to pass; missing GitHub or Vercel
  OIDC fails closed. Branch protection can require named workflow jobs, not
  these verification steps. `Decide whether to deploy` is the canonical push
  check; its credential-free skip is explicit and leaves the reader unverified.
  Once the binding is complete, require `Deploy the hosted CI relay
  (production)` when reader and relay verification are required on that path.
  `Deposit the GitHub App's credentials` runs only through the manual
  `app-credentials.yml` caller and is not a push check. A skipped job is never
  successful reader, writer, or relay verification. Failures print only
  `oidc_aud`, never an identity id, an OIDC subject, an access token or a
  secret value. Both workflow
  verification steps run `scripts/ci/relay-deploy-secret-store-verify-report.mts` so empty stdout or
  stderr-only crashes fail loudly. Before either job installs or signs in,
  `scripts/ci/relay-deploy-environment.mts` uses the job's scoped `GITHUB_TOKEN`
  to require an exact `main`-only custom deployment branch policy. The
  deploy-token read never signs in as the writer.

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

- **Trust:** the writer subject is GitHub's immutable repository prefix
  followed by `:environment:hobo-ci-app-credentials`; the reader subject ends
  in `:environment:hobo-ci-deploy`. Both pin repository
  ids, environment, `ref`, and called `job_workflow_ref` for `relay-deploy.yml`
  on `main`. The reader's top-level `workflow_ref` is also `relay-deploy.yml`;
  the writer's is `app-credentials.yml`, the only supported reusable caller.
  Their audiences and environments differ. Token TTL is **600s**.
- **Separation:** `hobo-ci-relay` remains **Viewer**. `hobo-ci-writer` is for
  App-credential deposit, never deploy-token reads. Deploy-token reads require
  the distinct `hobo-ci-deploy-reader`. The MCP/owner `hobo-secret-writer`
  keeps its one-use Universal Auth and has no GitHub Actions trust.
- **Scope:** relay reads `/hobo-ci-relay` in `prod`; writer deposits there;
  the deploy reader is a Viewer-only member of the `hobo-ci-deploy` project
  only. `verify` reads the deploy credential's value, checks that exact role,
  requires HTTP **403** for the reader's relay-folder listing and direct token
  read, and requires HTTP **404** for the reader's own relay-project membership.
  The writer and relay identity must likewise receive HTTP **403** for deploy-
  project listing and token reads and HTTP **404** for their own memberships.
  Verification never writes a probe secret. A successful cross-project read or
  membership fails; 401 proves no isolation; and every timeout, store error, or
  inconclusive answer fails closed. The real cross-project response remains
  **built, not proven** until the production observations below.
- **Residual:** writer Member can read/write secrets in **all environments**
  in the project ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12) — accepted on Free until upgrade or a future **(b)** code path. This residual is not inherited by the deploy reader: without a dedicated identity in a project of its own, `deployCredentialIdentityId` stays unset and deployment refuses to read a token.

**(b)** on Free does **not** tighten today's attach binding: `hobo ci app
deposit` writes `store.projectId` and `store.secretPath`, so App credentials
stay in the relay project. A second project (`deployProjectId`) scopes the
deploy credential away from the relay project. A binding without that project is
valid in credential-free mode, but cannot authorize deployment. Infisical
project roles cover the whole project ([RBAC](https://infisical.com/docs/documentation/platform/access-controls/role-based-access-controls); checked 2026-11-12), so a configured deploy credential always lives in a separate
project at its root, read by the dedicated `deployCredentialIdentityId`, never
the writer in `deployIdentityId`. The owner must create `hobo-ci-deploy`, its
read-only `hobo-ci-deploy-reader` identity, and deposit the token at its root
through the MCP capture connector's `deploy` target (or `hobo-secret-writer`).
A binding without `deployProjectId`, `deployCredentialIdentityId`, and
`deployOidcSubject` is credential-free: a direct real deploy fails closed before
requesting GitHub OIDC or authenticating to Infisical, while `--dry-run` can
inspect the plan. A missing project or token stops preview after repair.
**Built, not proven**: owner provisioning of that project, identity and token is
still required, and no qualifying production run is linked yet. After
provisioning, link both observations here:

- A successful production `relay-deploy` run whose *Verify the protected deploy
  environment* step attests the exact `main`-only policy; whose *Verify the
  secret store connection* step passes the reader with exactly Viewer, HTTP 403
  for the relay-folder listing and direct token read, and HTTP 404 for relay-
  project membership; whose preview step records `deploy token read from the
  deploy credential project as hobo-ci-deploy-reader`; and
  whose production deploy and origin verification succeed.
- A successful `app-credentials` run whose *Verify the protected writer
  environment* step attests the exact `main`-only policy and whose writer check
  passes sign-in, HTTP 403 deploy-project read isolation, and HTTP 404 deploy-
  project membership.

An OIDC-only verification or skipped deploy is not evidence. Record only run
links, secret references and outcomes, never the token or OIDC JWT.

**Cutover sequence** (fail closed while incomplete): `hobo ci deploy --dry-run`
can still plan; every real deploy refuses a
credential-free binding before GitHub OIDC or Infisical authentication. The
owner (Tyler) completes provisioning before enabling deployment:

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
   by `:environment:hobo-ci-deploy`, and the pinned repository ids, environment,
   `ref`, `workflow_ref` and `job_workflow_ref` documented above. Give the writer
   the distinct `hobo-ci-app-credentials` environment and its own audience.
   `connect` in step 5 applies both exact configurations with the owner's token.
4. Deposit `VERCEL_TOKEN` at the `hobo-ci-deploy` project's root through the
   MCP capture connector's `deploy` target (or `hobo-secret-writer`).
5. The owner runs `hobo ci secret-store connect --cwd packages/ci-vercel --yes`
   in their own terminal with the deploy project and reader ids as its
   `--deploy-project-id` and `--deploy-credential-identity-id` options, and
   with `INFISICAL_TOKEN` from their own `infisical login` for that one run so
   both GitHub Actions identities' trust is repaired in place. It records the
   deploy project, reader id and writer environment subject. Without those values
   it preserves credential-free mode; supplying only one fails with the missing
   paired option.
6. Nothing is committed: `connect` rewrote the binding in the owner's store.
   The next deploy through `hobo cd` with the owner's store session must
   provide the production observations above: protected-environment attestations, value read as the dedicated
   reader, exact Viewer, HTTP 403 read isolation and HTTP 404 membership checks,
   then successful production deploy and origin verification.

The strict parser accepts either a complete deploy credential or no deploy
credential; it rejects a half-configured pair. The confined repair parser still
accepts earlier shapes for connect, token-free dry-run planning and read-only
hosting evidence, never for a deploy-credential read. A binding that records a
reader id must have a separate deploy project, the writer's protected-environment
subject, and a reader distinct from the relay and writer identities.

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
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy` (`deployIdentityId`) | viewer | GitHub Actions writer trust: `aud` `https://github.com/<owner>`, `sub` `<sub_claim_prefix>:environment:hobo-ci-app-credentials`, repository ids, environment, `ref`, `workflow_ref` and `job_workflow_ref` pinned |
| `hobo-ci-deploy` | `prod` / `/` | `hobo-ci-deploy-reader` (`deployCredentialIdentityId`) | viewer | GitHub Actions reader trust: `aud` `https://github.com/<owner>/hobo-ci-deploy-reader`, `sub` `<sub_claim_prefix>:environment:hobo-ci-deploy`, repository ids, environment, `ref`, `workflow_ref` and `job_workflow_ref` pinned; `verify` requires this exact role and HTTP 403 from the relay folder |

The deploy identity and dedicated reader are Viewer-only members of
`hobo-ci-deploy` in the provisioned layout; only the relay identity belongs to
`hobo-ci`. Distinct protected environment and workflow claims prevent a
reader-eligible job from selecting the writer's audience and authenticating as
the writer.

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

A binding that configures a deploy credential records a `deployProjectId` other
than the relay's and a read-only `deployCredentialIdentityId`, distinct from the
relay and writer identities. The parser rejects identity reuse and a
half-configured pair. A credential-free binding skips the workflow deploy and is
refused by direct real deploy commands until `connect --deploy-project-id …
--deploy-credential-identity-id …` records both (sequence above). The deploy
credential always has a project of its own so the relay's identity, a member of
`hobo-ci` only, can never read it (Infisical project roles cover the whole
project). Endpoints: `POST /api/v1/admin/bootstrap` (self-hosted only),
`POST /api/v1/projects`, `POST /api/v1/folders`,
`POST /api/v1/projects/{projectId}/identities`,
`GET /api/v1/projects/{projectId}/identities` for the reader's roles, `POST /api/v1/auth/oidc-auth/identities/{identityId}` (`PATCH` of it on a
connect re-run), GitHub's `GET /repos/{owner}/{repo}` and
`GET /repos/{owner}/{repo}/actions/oidc/customization/sub` for the subject,
and at finalize `DELETE`/`GET /api/v1/identities/{identityId}`. The admin calls
are pinned by
[`infisical-admin.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-admin.pact.json)
and membership by
[`infisical-api.pact.json`](../adapters/adapter-infisical/contracts/pacts/infisical-api.pact.json).

The coordinates (the store's origin, project ids, the identity ids, the
Vercel team id, the deploy subject and the claim bundle id) are the
`SecretStoreBinding` record of
[`secret_store_claim.proto`](../secret-store-claim/data-models/secret_store_claim.proto),
written to the owner's own secret store as `HOBO_CI_SECRET_STORE_BINDING`. They
are the owner's private settings: HoBo reads them through the owner store
session when `hobo ci` or `hobo cd` runs and never commits or prints them.

## What the relay deployment declares

No store coordinate is a Vercel variable. The config-service binding of the
relay's Yard ([`deploy/yard.ts`](deploy/yard.ts)) names the capability and the
path its coordinates are bundled at (`bundledBindingFile`), and asks the deploy
for no input. `hobo ci deploy --build prebuilt` writes the relay's six
coordinates from the owner store session into that path for the duration of
`vercel build` only. A `--set` of an `INFISICAL_*` coordinate is refused like
any other undeclared setting. A Git build carries no coordinates, so its
production `/readyz` stays not ready and HoBo never qualifies it.

## The deploy workflow on `main`

[`.github/workflows/relay-deploy.yml`](../../.github/workflows/relay-deploy.yml)
holds no store coordinates: none is committed, and none is an Actions secret or
variable. Its unprotected gate therefore deploys nothing on a push. On a push
that changes the relay it posts a notice that the relay deploys through
`hobo cd` with the owner's store session (`hobo ci deploy --build prebuilt`
after HoBo MCP's `choose_secret_store`). A manual run (Actions → HoBo relay
deploy → Run workflow) starts the protected deploy job, whose `hobo` commands
stop with `HOBO_CI_SECRET_STORE_SESSION_REQUIRED` unless an owner store session
is established for them. With one, the protected deploy job signs in
with its GitHub Actions OIDC token as `hobo-ci-deploy-reader` from
`deployCredentialIdentityId` and reads `VERCEL_TOKEN` from the deploy project's
root, masked in the log. A direct deploy with no configured credential stops
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

A folder the relay reads but cannot use is named at `/readyz`: `state:
"not-configured"` with `missing` (required entries that are absent) and
`invalid` (entries their parser refuses), names only.

While the folder is incomplete the relay serves its
[setup mode](README.md#setup-mode) at `/mcp`: the owner reads the same names
with `relay_setup_status` and fills them with `relay_setup_provide`, which
writes as `hobo-secret-writer` with a one-use client secret the owner enters
in the form, never through a workflow input or an Actions secret.

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
