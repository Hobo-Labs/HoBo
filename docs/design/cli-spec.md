---
type: Reference
title: "HoBo CLI Specification"
description: "This document is the canonical command contract for `@hobo/cli`. It keeps the CLI"
tags: [hobo, design]
---

# HoBo CLI Specification

This document is the canonical command contract for `@hobo/cli`. It keeps the CLI
small while preserving the design suite's role model: app developers and agents
drive one shared command path, while platform, policy, delivery, SRE, and
generation behavior are authored as SDK code or exposed through dashboard/MCP
surfaces.

## Canonical CLI Verbs

| Verb | Role | Semantics | Implementation issues |
|---|---|---|---|
| `up` | lifecycle | Realize the current object graph: build, plan, gate, provision, and deploy — Desired State Reconciliation, so a re-run is idempotent and a changed declaration is an upsert. `--what-if` (aliases `--dry-run`, `--preview`) prints the change set and changes nothing; `--mode incremental` (default) keeps and `--mode complete` prunes resources no longer declared. `--camp`, `--strategy`, `--to`, `--rollback`, `--seed`, and `--restore` select target or revision without adding lifecycle verbs. `--broker` / `--broker-uri` target a remote broker (discovery required); `--anonymous` / `--temporary` request an ephemeral deploy when discovery advertises support. Without a flag, environment, or profile broker selection, use the local embedded broker. | HOBO-130, HOBO-164, HOBO-198, HOBO-203, HOBO-208, HOBO-213, HOBO-219, HOBO-224 |
| `down` | lifecycle | Tear down what `up` realized, in reverse dependency order. `--what-if` (aliases `--dry-run`, `--preview`) lists what would be destroyed. A later `up` re-creates it. | HOBO-132 |
| `dev` | local loop | Run against `runtime-local` with hot reload, replay, codegen-in-watch, and honest fidelity labels. Every workload lane participates: wasm components in any supported language recompile in-watch and OCI-fallback services restart-on-change per the dev-loop matrix ([ADR-0109](./adr/07-portability-extensibility.md#adr-0109)). | HOBO-122, HOBO-190, HOBO-198, HOBO-392, HOBO-612 (draft POC: `src/draft/technical-proofs/hobo-612-dev-local-loop-poc/`) |
| `new` | local loop | Scaffold a runnable SDK program. | HOBO-118, HOBO-198 |
| `login` | identity | Obtain a dev SVID through OIDC; never paste provider keys. Optional `--broker` / `--broker-uri` associates a default remote broker on the HOBO_HOME profile (identity plane; not placement). | HOBO-136, HOBO-184 |
| `connection` | identity | Manage durable Station-owned Connections (create/authorize/list/get/revoke/rotate). Scoped by `--station` / profile.defaultStation. | HOBO-connection, ADR-0131 |
| `identity` | identity | Observe identity migration (status/inspect), or manage auth.md agent registration, claim, scoped token exchange, rotation and revocation (`agent discover/register/status/claim/poll/token/rotate/revoke`). Agent identity, human login and infrastructure ownership remain separate. | ADR-0132 |
| `trails` | migration | Observe continuous migration Trails (`status`, `plan`, `inspect`). App-owned recipes; identity continuous stays zero Bindle config (`identity.continuous` compose). | ADR-0134 |
| `access` | identity | Request elevated or cross-env access / break-glass (short-lived capability; audited). | ADR-0133 |
| `feature` | delivery | OpenFeature flags, canary, and experiment observe (`list`, `eval`, `set`, `kill`, `canary`, `experiment`). Sole app evaluation API is OpenFeature; no vendor SDKs. | ADR-0044, ADR-0083 |
| `deploy` | delivery | HoBo.CD continuous delivery ([ADR-0182](./adr/01-architecture-core.md#adr-0182)): Freight (`freight record/list/show/yank/approve`), sources (`source define/list/poll`), pipelines (`pipeline apply/show/list`, including `--file hobo.delivery.ts`), windows (`window define/list/override`), promotion (`promote`, `status`, `logs`, `rollback`, `reconcile`, `preview`, `verify show`, `metrics`), agents (`agent token/enroll/approve-key/accept/run/revoke`), publishers, fleet (`campset`, `camp`, `placement`, `scores report`, `fanout`, `failover`, `rebalance`) and `compliance show`. Subcommands of one verb, not new verbs; `--simulate` is the only fixture path and labels every result. Secret-free status; no ambient credentials; agent principals propose by default. Reference: `packages/hobo/CD.md`. | ADR-0083, ADR-0008, ADR-0182 |
| `ci` | delivery | Connect a GitHub repository to isolated CI (`enable`, `connect` alias), inspect its connection (`status`), and manage Actions runs (`list`/`ls`, `inspect`, `logs`, `grep`, `rerun`). Works without a Bindle. **Lifecycle family:** `ci up` / `ci down` / `ci plan` converge the CI project through the same engine as `up`/`down`/`plan` (see [Lifecycle families](#lifecycle-families)). `deploy` is the legacy single-relay path: it deploys the hosted relay's own Bindle to Vercel from a git ref (preview by default, `--dry-run` sends nothing). [Setup and Vercel parity](../../packages/hobo/CI.md). | ADR-0071, ADR-0083 |
| `cd` | delivery | **Lifecycle family** for the CD project: `cd up` / `cd down` / `cd plan` / `cd status` converge it through the same engine as `up`/`down`/`plan` (see [Lifecycle families](#lifecycle-families)). Any other subcommand is `deploy` (`hobo cd freight list` ≡ `hobo deploy freight list`). | ADR-0182 |
| `incident` | delivery | CD failure disposition (`status` lists failed, rolled-back and rejected promotions and open failovers; `open` rolls the Camp back through the HoBo.CD gate, then A2H or sandboxed self-heal). Default A2H; self-heal only in ADR-0076 lane; an agent principal's rollback is a proposal. | ADR-0082, ADR-0094, ADR-0076, ADR-0182 |
| `claim` | identity | Bind an anonymous `npx hobo up` deployment to an account while preserving state and URL. Local: event-store rebind. Remote: `hobo claim <account> --broker <uri> --token <claimToken>` exchanges the claim token without re-provision. Provider ownership is a separate ceremony: `status` lists every claim item with its own deadline and outstanding obligations, `open <item>` redeems that item's one-time action, and `finalize <item>` verifies ownership and discharges obligations before the item may complete. | HOBO-136, HOBO-164, ADR-0151 |
| `recipes` | read-only | List and inspect deployment recipes (`list`, `show <recipe-id>`): Yards, placements, bootstrap classes, claim terms, and required consents, before any provider login. | ADR-0151 |
| `offer` | read-only | Compile the signed `DeploymentOffer` a human consents to before any effectful provider call: providers, realization, claim count and earliest deadline, custody, disclosures, sponsored cost cap, and portability. Read-only by construction. | ADR-0151 |
| `plan` | read-only | Dry-run the `up` decision: DeploymentPlan, Matching choices, cost, and warnings as an approvable diff. | HOBO-125, HOBO-203, HOBO-208 |
| `verify` | read-only | Optional preflight for the unified Gatekeeper decision. `up` still runs the same gate automatically before mutation. | HOBO-146, HOBO-227 |
| `can-deploy` | read-only | Compatibility-matrix diagnostic for producer/consumer skew; an input to `verify` and `up`. | HOBO-123, HOBO-146 |
| `inspect` | read-only | Render projections and time-travel views such as `run`, `deploy`, and `topology`. | HOBO-140, HOBO-216 |
| `logs` | read-only | Live-tail logs and streams through the Camp runtime Streamer. | HOBO-143, HOBO-216 |
| `doctor` | diagnostics | Report environment, credential, connectivity, and portability hazards. | HOBO-147, HOBO-184, HOBO-190 |
| `messaging` | diagnostics | Inspect messaging capability + delivery-guarantee readiness (Kafka/Redpanda, optional Dapr Camp runtime); pure readiness section also surfaces in `hobo doctor`. | ADR-0138 |
| `codegen` | authoring | Regenerate checked-in `_generated/`; `--check` fails on drift. | HOBO-152 |
| `build` | authoring | Compile services to wasm components with an OCI fallback; fails on generated drift. | HOBO-156 |
| `collect` | authoring | Run resource collection and print the provider-agnostic manifest IR. | HOBO-160 |
| `stub` | authoring | Run with a contract-backed stub behind a WIT port while implementation is generated or deferred. | HOBO-160, HOBO-392 |
| `drift` | diagnostics | Report drift and route governed remediation through proposals or gated `up` convergence. | HOBO-216, HOBO-369 |
| `add` | distribution | Install a provider/listing as available to deterministic selection after signature, provenance, and conformance checks. | HOBO-362, HOBO-365 |
| `registry` | distribution | Registry administration subcommands, including signed offline bundle import for air-gapped Yards. `hobo registry add <manifest>` registers a provider described by a [provider manifest](./provider-manifest.md) data file: held on the first run, approved for matching on the second. | HOBO-350, HOBO-383 |
| `import` | migration | Adopt an existing estate in place as adopted/external resources; never destroy/recreate on import. | HOBO-225, HOBO-369 |
| `generate` | generation | Request the provider-generation loop for a backend/capability; certification still passes through conformance and Registry. | HOBO-207, HOBO-348 |
| `sandbox` | test loop | Run a system-under-test in an isolated lane with out-of-scope boundaries served from contracts. | HOBO-190, HOBO-392 |
| `test` | test loop | Alias for the contract-backed sandbox test lane; not a replacement for project test runners. | HOBO-190, HOBO-392 |

| `attest` | governance | Produce signed OCSF, control, or model-card evidence exports from replayable audit facts for external GRC tools. | HOBO-175, HOBO-196, HOBO-282 |
| `erase` | governance | Request crypto-shred erasure and projection rebuild for a data subject without rewriting historical events. | HOBO-295 |
| `broker` | governance | The broker (the Conductor) on the CLI. Requires Station context when available (profile / `HOBO_STATION` / `--station`); receipts pin `stationId` + `railHash`. `broker config [--init]` scaffolds/validates `hobo.broker.json` (importable as a Rail under a Station); `broker up [--config --request]` assembles the Conductor against Station + active Rail + local-host catalog when no cloud config; `broker resolve --policies --request` runs one resolution; `broker matrix` prints the closed rejection-code catalog. App lifecycle stays `up`/`down`. | HOBO-521, HOBO-525, HOBO-528, HOBO-529 |
| `serve` | control plane (local) | **Local control-plane HTTP+SSE** for the Yard game UI (`hobo serve control`). Same management surface as station/connection verbs; default `127.0.0.1:8790`. `hobo serve cd` hosts the HoBo.CD service (tick loop, conductor reconciler, `/v1/cd/` read API and agent delivery feed, `/healthz`, `/readyz`; default `127.0.0.1:8791`). | ADR-0150 |
| `yard` | control plane | Install, equip, and inspect the local Yard (`init`, `ensure`, `status`, `doctor`). Setup and diagnostics, not a second lifecycle verb. | ADR-0131 |
| `station` | control plane (ops/setup) | **Station occupancy setup/ops family — not a lifecycle verb.** `station init` creates a Station under `HOBO_HOME` with a sealed bootstrap Rail and sets `profile.defaultStation` (imports existing `hobo.broker.json` as an approved Rail when present); `station up` / `station down` start/stop occupancy (data retained on down); `station status` projects isolation, active Rail hash, bootstrap-active, Connection counts; `station rails` manages Rails (`list`, `publish`, `approve`, `activate`, `status`). Missing Station fails closed with remediation `hobo station init`. | ADR-0131 |
| `replay` | observability | **Session Replay** (DOM/session reconstruction on every **App Kit**) — subcommands `list`, `get`, `open`, `summarize`, `retention`, `doctor`. Distinct from control-plane event-log replay and auth `session.*`. Local dual fixtures default-on for all App Kits (not only `web`); production flag/sample gated; `HOBO_REPLAY=0` kill switch. MCP parity via CANONICAL_VERBS. | ADR-0137 |
| `derivative` | extensibility | Manage derived HoBo implementations; `derivative upgrade` checks descriptors, runs upcasters, and reruns conformance. | HOBO-36, HOBO-336, HOBO-386 |
| `runbook` | SRE | Execute or replay declarative incident runbooks; write actions still pass through policy obligations. | HOBO-260, HOBO-285 |


## Station context resolution

For `station`, `broker`, `connection`, `up`, and `login --station`:

1. `--station` / `--station-uri`
2. `HOBO_STATION` / `HOBO_STATION_URI`
3. `profile.defaultStation`
4. Fail closed with remediation `hobo station init`. Never silently create durable Station state.

## Lifecycle Semantics

`up` and `down` are the only lifecycle verbs. `station` is an ops/setup family like `broker` / `connection` / `registry` — never a second lifecycle. `up` subsumes deploy,
promotion, rollback, self-host bootstrap, and restore through flags:

```bash
hobo up
hobo up --camp prod
hobo up --camp prod --to <revision>
hobo up --rollback
hobo up ./platform --seed
hobo up ./platform --restore <log>
hobo up --broker https://broker.example.com
hobo up --broker-uri https://broker.example.com
hobo up --broker https://public.example.com --anonymous
hobo up --broker https://public.example.com --temporary
hobo login --broker https://broker.example.com
hobo claim acme
hobo claim acme --to acme
hobo claim acme --broker https://public.example.com --token <claimToken>
hobo down --camp pr-123
```

### Idempotent deployment and the what-if

`up` is Desired State Reconciliation over the durable log
([control-plane.md](./control-plane.md#the-resourceactor-reconciliation-fsm)):
the declaration is compared with what the log recorded, and only the
difference is applied. The flag names are the ones Bicep, az, wrangler and
Pulumi users already know:

| Flag | Verbs | Meaning |
|---|---|---|
| `--what-if`, `--dry-run`, `--preview` | `up`, `down`, family `up`/`down` | Print the change set (`create` / `update` / `no-op` / `delete` / `retain`, or what `down` destroys); read the log only, call no provider. |
| `--mode incremental` (default) | `up`, `plan`, family `up`/`plan` | Keep resources the log provisioned but the declaration no longer names (reported `retain`). |
| `--mode complete` | `up`, `plan`, family `up`/`plan` | Destroy them, dependents first, after the declared resources converge. |

`plan` always reports the same change set beside the plan. Re-running `up`
with an unchanged declaration calls no provider and records nothing.

### Lifecycle families

A family is a HoBo project of its own, a Bindle with a CLI, whose lifecycle is
the same three commands pointed at that project instead of the working
directory. There is no second engine, so every family inherits idempotency,
upsert, what-if and modes:

```bash
hobo ci up              # ≡ hobo up   --cwd <the CI project>
hobo ci up --what-if    # ≡ hobo plan --cwd <the CI project>
hobo cd down            # ≡ hobo down --cwd <the CD project>
hobo cd status          # the what-if, read-only
hobo cd up --mode complete
```

Explicit `--mode` is supported by the Yard desired-state and direct
orchestrator lanes; broker placement and budgeted hosting refuse it until
their execution paths can honor it.

The project resolves from `--project <dir>`, then `HOBO_CI_PROJECT` /
`HOBO_CD_PROJECT`, then the project HoBo ships for the family, then the working
directory when it holds a Bindle. A family may connect a provider before `up`
converges (the GitHub App for CI, Vercel for CD). That step is idempotent: it
finds the connection already in the secret store and does nothing, and a
refused connection stops `up` before anything is created. `hobo ci status`
keeps inspecting the relay connection. Every other family subcommand keeps its
existing meaning (`hobo cd <x>` is `hobo deploy <x>`). Families add no
lifecycle verbs: `up` and `down` remain the only two.

`hobo ci plan` and `hobo ci up --what-if` place the CI project through the
relay's own Yards (`packages/ci-vercel/deploy/yard.ts`: the Vercel project
`hobo-ci` and the Yards its junction joins), never through whatever providers
are registered on the machine, so the plan is the relay's real placement.
`hobo ci up` then delivers the current branch to that project's preview the way
`hobo ci deploy` does, with the Vercel connection `hobo cd up` keeps in the
owner's secret store (handed to the deploy in a trusted vault; without it, `up`
refuses and points at `hobo cd up`). Production stays an explicit promotion:
`hobo ci deploy --target production --sha <commit>`.

Placement refuses a Bindle whose `b.external()` would put an external in a
Yard (`HOBO_YARD_EXTERNAL_FORBIDDEN`) before anything is planned: `plan`, `up`,
`up --what-if` and every family lifecycle. Declare that service in a Yard
whose provider runs it and join the Yards with a Junction. A
`b.external({ managedBy: { provider, via: "marketplace" } })` annotation
alone is not evidence of a Marketplace relationship and is also refused until
placement can verify it ([control-plane.md](./control-plane.md)).

### Ceremonies: configure what is missing, don't refuse

Every infrastructure `up` (`hobo up`, `hobo ci up`, `hobo cd up`) holds an
interactive ceremony for what it is missing, on a local setup page rendered
with vercel-labs/ui (`@hobo/connect-ui`). It never tells a person to go set
environment variables.

- **The secret store first.** Where it is (Infisical, 1Password or Bitwarden,
  and its project, vault or organization ids, plus an optional OIDC identity
  for CI) is a locator of ids in the owner's own HoBo settings
  (`~/.config/hobo/projects/<project>/secret-store.json`, mode 0600, never
  in the repository; an older in-tree `.hobo/secret-store.json` is moved
  there on first read). No secret is ever written to it. The sign-in is held in the run's trusted
  vault (memory only, wiped when the run ends) and is one of
  (`INFISICAL_SIGN_IN`, a non-secret setting): a token typed on the page
  (`typed`, the default; or unlocked by the 1Password desktop app); a token
  the agent's egress proxy injects (`egress-proxy`); a browser approval of an
  Infisical OAuth application (`oauth`: authorization code + PKCE redirected
  to `http://127.0.0.1:8793/infisical/callback`; its tokens only read
  secrets, so the store opens read-only and a write refuses with
  `HOBO_INFISICAL_READ_ONLY`); or a CI run's own OIDC token.
- **Everything else lives in the store.** What a ceremony is told (`hobo ci
  up`: the relay URL and the GitHub owner, a user **or** an organization;
  `hobo cd up`: HoBo CD's Vercel Integration) is kept as `HOBO_CI_SETTINGS` /
  `HOBO_CD_SETTINGS` beside the credentials, so a destroyed devbox is set up
  again by signing in and nothing is asked twice.
- **No secret in the environment, on disk or in a temporary file.** Secret
  environment variables are ignored and named (`ignoredSecretEnvNotice`);
  child processes get an environment without them; a credential a run needs
  (the junction's Vercel token, the deploy token) reaches the deploy through
  the trusted vault, never `process.env` or `$GITHUB_ENV`. A test scans the
  lifecycle sources so none reads a secret variable again
  (`packages/hobo-ci/test/secret-custody.test.ts`).
- **Providers**: when planning finds a resource no connected provider serves,
  `hobo up` offers the installable providers that advertise its port, connects
  the chosen ones (`hobo add`, approving a held one) and runs `up` again.
- **Agents** can complete a ceremony too (`createAgent`, WebMCP). Handing off
  to a provider or submitting a secret asks the person.
- **An agent hands the ceremony to the person** (`--hand-off`): the run
  serves nothing on the agent's machine and nothing redirects back to it, so
  the person can be anywhere. The store must open without a page (a
  workload's OIDC, or `INFISICAL_SIGN_IN=egress-proxy`, the hand-off default
  when no sign-in was selected (an explicit choice is preserved):
  the run sends a placeholder and the agent's egress proxy injects the
  owner's Infisical access token, given out of band). Post-back: until the
  store answers, the run prints one `HOBO_OWNER_CREDENTIAL host=<host>
  guide=<url> — <steps>` line and polls (`awaitHandOffStore`), carrying on in
  the same run once the owner's token arrives; at its deadline it refuses with
  `HOBO_CI_STORE_NEEDS_SIGN_IN` / `HOBO_CD_STORE_NEEDS_SIGN_IN`, naming every
  store path with its guide (`storeSignInGuidance`). CI reads the relay's own
  folder (`/hobo-ci-relay`), so the relay's existing GitHub App is reused;
  it needs the App already in the store: creating one needs GitHub's page, so it refuses with
  `HOBO_CI_APP_NEEDS_OWNER`, naming only the owner's own terminal run: GitHub's
  one-time code must reach the owner's run, never a HoBo service that would
  broker their App's keys. CD connects Vercel with the OAuth
  device grant: one `HOBO_OWNER_DEVICE <link> code=<code>` line, approved on
  vercel.com from any device. `--json` and `-q` are refused because they
  hide those lines (only when the owner is actually needed: an existing
  connection still converges silently). The agent never answers the
  ceremony itself. The remote-box evals
  (`packages/hobo-ci/test/evals`, `packages/hobo-cd/test/evals`) hold both
  lifecycles and the hobo-deploy skill to this: no loopback line, post-back
  into the same run, and a refusal with outside paths when nobody acts.
- **The owner chooses the store.** A handed-off run never assumes one: with
  none chosen it refuses with `HOBO_CI_STORE_CHOICE` / `HOBO_CD_STORE_CHOICE`
  and one `HOBO_OWNER_STORE_CHOICE` line per option (Infisical, 1Password,
  Bitwarden), and the agent asks with a picker. From a remote box,
  Infisical signs in with a Token Auth token the egress proxy injects, and
  1Password through the owner's 1Password Connect server
  (`OP_CONNECT_HOST`; its access token is a bearer the proxy injects:
  `createOnePasswordConnectClient` over the same `1password` SecretsPort).
  **No manual provisioning (Infisical, 1Password).** Once the owner chooses
  the store, the run sets up its own access with the provider's CLI and API
  (`provisionInfisicalAccess`, `provisionOnePasswordAccess`; specified in
  `packages/hobo-ci/test/spec/`). It installs the store's CLI when it is
  missing into HoBo's tools directory (`~/.local/share/hobo/tools`, never
  globally: `@infisical/cli` from npm, `op` from 1Password's download),
  uses an existing CLI session, or has the owner sign in once (Infisical in
  the browser; 1Password approved in the 1Password app). Then it creates,
  through Infisical's API, a machine identity with OIDC Auth bound to the
  workload's issuer where there is one (no bearer token exists) or Token
  Auth otherwise, its project membership and this run's token; for
  1Password, a one-day service account scoped to the one vault
  (`op service-account create`; 1Password has no OIDC sign-in for service
  accounts). Infisical's browser sign-in hands the session to
  `127.0.0.1:<callback_port>` on the machine the browser runs on, so a
  remote run signs in with no inbound connection and no tunnel: run through
  the HoBo MCP server (its `ci`/`cd` tools, which hold the owner channel), it
  refuses once with `HOBO_OWNER_SIGN_IN url=<sign-in link>
  capture=INFISICAL_CLI_SESSION`; the owner signs in in their own browser
  (SSO, MFA as usual), and Infisical, unable to reach a CLI, offers its
  session to copy ("Unable to reach CLI", Copy to clipboard: base64 of
  `{JTWToken, email}`); the owner pastes it into the HoBo MCP App's
  secret-capture form, which seals it in their browser for a `handoff`
  capture (to the waiting run, in the server's memory, taken once, never a
  store or file); the next run decodes it and provisions through the API,
  over the environment's proxy. 1Password's app approves sign-ins on its
  own machine, so a remote 1Password run without an `op` session refuses
  with `HOBO_*_ONEPASSWORD_SIGN_IN`. A sign-in
  the owner chose explicitly (`INFISICAL_SIGN_IN`, `OP_ACCOUNT`,
  `OP_CONNECT_HOST`) stands. Only the composed CLI hands `prepare` the
  machine (`runCommand`), so no test runs real commands.
  Bitwarden Secrets Manager is used through its API from any box: the
  access token the environment provides (`BWS_ACCESS_TOKEN`) is the one
  sign-in a run takes from its environment, moved into its trusted vault
  and out of the process environment (`adoptStoreSignIn`). A provided token
  only marks Bitwarden "configured here" in the picker: choosing a store is
  always the owner's step (`HOBO_*_STORE_CHOICE` until `HOBO_SECRET_STORE`
  is set), and the token is used only once they choose Bitwarden. With no
  token, the run provisions one (`provisionBitwardenAccessToken`): it signs
  in with the owner's personal API key, which the ceremony collects: the
  setup page asks for it at the owner's terminal, and from a remote box the
  run prints `HOBO_OWNER_CREDENTIAL host=identity.bitwarden.com` and the
  owner saves it in the session's credential form as a username (client_id)
  and password (client_secret), which the egress proxy sends as HTTP Basic
  client authentication (RFC 6749 §2.3.1; the run never holds it). Optional
  environment variables (`BW_CLIENTID`/`BW_CLIENTSECRET`) are adopted into
  the vault like the token. Signing in makes the run's device one
  Bitwarden knows (a "log in with device" request is accepted only from a
  known device); picks the organization with Secrets Manager (or
  `BWS_ORGANIZATION_ID`) before asking anything; sends one login request and
  prints `HOBO_OWNER_BITWARDEN_APPROVE server=<host> phrase=<fingerprint>`;
  and, once the owner approves it in a signed-in Bitwarden app, finds or
  creates the project and machine account `hobo`, grants it read and write,
  and creates a one-day access token. Names and keys are encrypted in the
  run as Bitwarden's clients do it (`bitwarden-crypto.ts`, checked against
  Bitwarden's SDK test vectors); account and organization keys are zeroed
  before it returns, the token goes only to the run's vault, and the
  locator keeps the ids and a stable device id (`BITWARDEN_DEVICE_ID`).
  **Vaultwarden** (or self-hosted Bitwarden) is the same flow against the
  owner's own server: `BITWARDEN_SERVER_URL` (a parsed https origin) points
  the API at `<origin>/api` and sign-in at `<origin>/identity`, for both
  provisioning and the Secrets Manager SDK. Vaultwarden has no Secrets
  Manager, so where the chosen organization lacks it the run finds or
  creates the collection `hobo` and keeps each secret as a secure note
  there (`createBitwardenVaultSecretsPort`: name and value encrypted with
  the organization key, one version per secret, its revision date); the
  locator records `BITWARDEN_STORAGE=vault` and `BITWARDEN_COLLECTION_ID`
  (internal ids, never page fields: the page shows only the optional
  server address), and each run holds the organization key in memory after
  the owner's approval. A self-hosted server reads the API key only from
  the request body, which an egress proxy cannot fill, so a remote run
  against one refuses with `HOBO_*_BITWARDEN_NEEDS_API_KEY` and names the
  setup page at the owner's terminal. The post-back wait (`HOBO_OWNER_CREDENTIAL host=<host>`) names the store's own
  host.
- **A provider's redirect to a remote run** (`hobo ci app create
  --hand-off`; GitHub's App manifest code). The run listens on 127.0.0.1
  only, under one unguessable path that takes one callback with a state
  check. A configured receiver (`--receiver` / `HOBO_REDIRECT_RECEIVER`:
  `cloudflared`, `ngrok`, `localtunnel`, `devtunnel`, `pangolin`, `command`)
  is the owner's own outbound-only dev tunnel: its client dials out to the
  provider's edge, the run proves the tunnel carries a request before it
  shows the link (`HOBO_OWNER_APP <https url>`), and the tunnel closes with
  the run. HoBo runs no receiver. Without one, or when it fails, the owner's
  hand-off carries the result: `paste` (default; a static page shows
  GitHub's single-use `code~state`, which the agent writes to the run's
  stdin) or `store` (`HOBO_OWNER_APP_REGISTER`: GitHub's prefilled form, the
  owner stores the App, the run checks it with GitHub).
- **Ceremony settings are parsed, not validated** (`parsed-values.ts`): each
  outside value (a 1Password vault id, a Connect host, a tunnel's public
  address, the proxy URL, the App hand-off mode) becomes a branded type where
  it enters, or is refused there by name (`SettingParseError`). Code past the
  parser takes only the brand, and the setup page's check is derived from the
  same parser (`checkedBy`), so one rule lives in one place.
- **Egress is read once, up front** (`egressFrom`): the HTTPS proxy the
  environment requires, its bypass list and CA bundle. The run's own
  requests go through it (`egressFetch`), tunnel CLIs start with it and no
  secret variable, and a receiver whose client cannot use a required proxy
  (cloudflared, localtunnel, pangolin) is never started: the run says why
  on one `HOBO_REDIRECT_RECEIVER_EGRESS` line and goes straight to the
  hand-off. Evals: `packages/hobo/test/evals`, `packages/hobo-ci/test/evals`.
- **A refusal is never a dead end.** Human output prints a result that did
  not succeed with its code and every remediation line, even when there are
  no suggested actions; `--json` carries those lines in `remediation`.
- Without a person at a browser and without `--hand-off`, and for
  `--what-if`, nothing opens. The
  result says what it would sign in to and ask for, points CI at a
  preconfigured OIDC identity, or names the `hobo add` that would satisfy each
  resource.

- **Every step reachable from a remote box.** A handed-off run's owner may
  be anywhere: no step sends them to a terminal, their own machine or the
  box's `127.0.0.1` (`remoteInfeasible` in `@hobo/hobo-ci` names such
  lines, and `test/spec/remote-*.spec.test.ts` drive each ceremony through a
  simulated remote owner, with a failure injected at every step). Values
  the waiting run itself reads go through the HoBo MCP server's secret
  capture (`target: handoff`), never chat or the session's credential form:
  `HOBO_OWNER_SIGN_IN url= capture=` (open a link, then hand back what it
  shows: Infisical's copied session; GitHub's App code from the static
  hand-off page, whose state nonce lives in the owner's HoBo settings) and
  `HOBO_OWNER_CAPTURE name= guide=` (one value each: a self-hosted
  Bitwarden API key; a remote 1Password sign-in, which `op account add`
  reads from `OP_SECRET_KEY` and standard input in a throwaway
  `OP_CONFIG_DIR`; a CI setting). Several captures are taken only once all
  have arrived. On a remote box whose host shows no MCP Apps,
  `capture_secret` asks in the host's own elicitation form (one field; the
  value goes host to server, never to the model); a host with neither is
  refused (`SECRET_CAPTURE_NO_OWNER_FORM`), never sent to a box-served page
  or a port preview the owner may not see. Every capture result carries
  `hostSupport`. A host's form blocks the chat, so a sign-in link is shown
  in chat first and the form opens only once the owner has copied the
  value; the form is one short line and one field. The host's tool limit
  is ten minutes (`MCP_TOOL_TIMEOUT` in `.claude/settings.json`) and the
  server answers `SECRET_CAPTURE_NOT_ANSWERED` just before it. Infisical provisioning reuses an identity,
  auth method and membership a failed run left behind, retries dropped
  connections and 5xx answers, names a proxy that refuses the tunnel (407)
  as the proxy, and turns an expired session into a fresh sign-in link.

### Broker targeting and anonymous deploy

Target resolution for `up` / default remote association:

1. `--broker` or `--broker-uri` (aliases)
2. `HOBO_BROKER` or `HOBO_BROKER_URI`
3. Persisted profile under `HOBO_HOME` / `~/.hobo/profile.json`
4. Embedded local broker (zero-config default)

The embedded broker is self-hosted. Hosted HoBo brokers and hosting relays are
optional; an explicitly selected network endpoint can also be self-hosted.
There is no automatic hosted-broker fallback. `--anonymous` / `--temporary`
alone do not select a network broker or impose a local lease TTL.

Remote paths **must** fetch a discovery document before place/claim. Anonymous/`--temporary` is **forbidden** unless parsed discovery supports it. An explicit `supportsAnonymous: false` takes precedence over the auth-method list; when omitted, support is derived from the `anonymous` auth method. Successful remote anonymous placement returns claim token/URL, expiry, primary URL, and any TTL/restrictions supplied by the broker (Cloudflare temporary / Lakebed claim style). Agents use SPIFFE-style SVID principals distinct from human login; DPoP-capable presentation is preferred for remote agent credentials.

Identity remains the identity plane (`login` / SVID / claim); placement remains the broker plane. No new lifecycle verbs.

`verify`, `can-deploy`, `plan`, `inspect`, and `logs` are read-only diagnostics.
They do not mutate infrastructure. `up` always reruns the applicable gate before
mutation, so a stale preflight result cannot authorize a deploy.

Local resilience diagnostics are read-only projections too. The HOBO-520 proof
command under `src/draft/technical-proofs/resilience-semantics-annex` demonstrates the shape that
`hobo dev`, `testRuntime`, or a later `inspect run` surface may render: retry
attempts, policy denial, cancellation cleanup, and deadline escalation are read
from replay-derived persisted facts, and stale in-memory snapshots are not an
authoritative source.

## Retired or Rejected Commands

| Command | Replacement | Decision |
|---|---|---|
| `destroy` | `down` | Retired. Teardown is the inverse of `up`. |
| `ship` | `up` | Rejected synonym. Shipping is convergence via `up`; use canonical `deploy` for HoBo.CD promotion, observation and rollback. |
| `teardown` | `down` | Retired. Use the same destructive verb everywhere. |
| `rollback` | `up` | Retired as a verb. Use `hobo up --rollback` or `hobo up --to <revision>`. |
| `promote` | `up` | Retired as a verb. Use `hobo up --camp <target> --to <revision>`. |
| `forge` | `build` | Rejected. Build/componentization is `hobo build`. |
| `train` | `up` | Rejected. Training is declared in code and promoted through the same gate. |
| `crew` | `inspect` | Rejected. The Crew is SDK code plus dashboard/MCP surfaces, observed through projections. |
| `fleet` | `inspect` | Rejected. Fleet views are dashboard projections and `hobo inspect` output. |

## Lint Contract

`npm run docs:cli-lint` scans Markdown command examples and `@hobo/cli`
package summaries. Fenced examples may use only canonical first-level `hobo`
verbs, and package summaries may not list retired verbs. This keeps examples
from reintroducing retired lifecycle, Yard, or Forge drift after this hardening
pass.
