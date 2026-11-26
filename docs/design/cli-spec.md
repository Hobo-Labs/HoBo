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
  hand-off page, whose state nonce lives in the owner's HoBo settings). A
  link is associated with its named capture, so concurrent hand-offs do not
  show one provider's link for another provider's form; consuming the value
  clears that link. `HOBO_OWNER_CAPTURE name= guide=` covers
  one value each: a self-hosted
  Bitwarden API key; a remote 1Password sign-in, which `op account add`
  reads from `OP_SECRET_KEY` and standard input in a throwaway
  `OP_CONFIG_DIR`; a CI setting. Several captures are taken only once all
  have arrived. On a remote box whose host shows no MCP Apps,
  `capture_secret` asks in the host's own elicitation form (one field; the
  value goes host to server, never to the model); a host with neither is
  refused (`SECRET_CAPTURE_NO_OWNER_FORM`), never sent to a box-served page
  or a port preview the owner may not see. Every capture result carries
  `hostSupport`. Through the HoBo MCP server the run asks the owner itself,
  in the call that needs it: every step is a form in the owner's host, its
  link alone on its own line inside it (Infisical's sign-in link with the
  paste field; Vercel's approval link and code with a Done button, after
  which the call waits on the grant's own outcome). No URL-mode link prompt
  is sent (a host may declare it and never show it), and no link is left
  for the agent to relay in chat: the spec model's "owner links reach the
  owner in the host" fails any result that asks the owner to open a link
  the host did not show them. The repository's `.mcp.json` gives the
  server's calls 30 minutes, so a form stays open while the owner signs in. A form stays open until the
  owner answers, the host cancels the call (`notifications/cancelled`,
  which withdraws exactly that call's prompts), or its deadline passes
  (`HOBO_OWNER_FORM_WAIT_MS`, 10 minutes by default, under the 30 minutes a
  call gets): a host can accept a form and never show it, and the live
  run's form sat open for the whole call. The server then withdraws it
  (`notifications/cancelled`, "No answer within …") and the run ends with
  its refusal and the link (`SECRET_CAPTURE_NOT_ANSWERED` for a capture),
  so the agent can fall back to showing the link once in chat. Every form
  is one line (no line breaks; the owner's app showed one-line forms and not
  multi-line ones). **Rule: a link reaches the owner as a target they can
  open or copy, never as text.** In a form it is a field of its own,
  prefilled and marked as a link (`format: "uri"`, `linkField`); an address
  in a form's text, bare or as markdown, showed in the owner's app as text
  they could neither click nor copy. The spec model's invariant "a form's
  links are fields the owner can open or copy" fails any form that carries
  a link only in its text, on every smoke and explorer run. The run asks
  in its own call only where a capture really is a host form (a remote box
  whose host shows forms and no MCP App); elsewhere it refuses and the
  agent's capture shows the App or the local page. Vercel's confirmation
  counts only with Done ticked, and its outcome is read back from the
  store and pinned, never assumed. The model holds the run's own forms to
  their links (a form belongs to the capture whose field title it has),
  checks every message the host receives for secrets, and never counts a
  crashed call (a JSON-RPC error, an error result with no code) as the
  frontier. A response to a form already withdrawn is dropped, and the
  entry point ends when the full server does. Through the MCP server, `cd`'s Vercel
  device grant runs off the request path (the owner channel's jobs) and
  writes the connection to the store when approved (RFC 8628 polling on an
  injectable clock); the call waits on the owner's form and then on the
  grant's outcome, an event, not a poll of its own. A form the owner closed
  comes back on the next run with the same link and code. Only a host that
  shows no form gets `HOBO_CD_VERCEL_AWAITING_APPROVAL` at once. The store
  sign-in HoBo created is kept in the server's memory (the owner channel's
  vault) so the owner signs in once. On a host with no form, the grant's
  link goes as the host's link prompt, completed
  (`notifications/elicitation/complete`) when its job ends. Completion
  follows the job identity even when two grants use the same URL; racing
  starts for one store show only the accepted grant. Egress is applied to
  the whole process at
  start (`applyEgressToProcess`: Node's global dispatcher, built on the
  first request so an unused CA path cannot stop a run): every fetch honours
  the box's proxy, bypass list and CA. The Infisical store offers a verified
  create-only (Infisical refuses an existing key; the entry is read back),
  so the CD journal's provisioning claim works on it. The real-binary smoke
  (`packages/hobo/test/evals/owner-ceremony-smoke.eval.test.ts`) drives the
  ceremony as the live host does, through a TLS-inspecting proxy answering
  as the providers' real hosts, and fails on any egress outside it. Infisical provisioning reuses an identity,
  auth method and membership a failed run left behind, retries dropped
  connections and 5xx answers, names a proxy that refuses the tunnel (407)
  as the proxy, creates the store's folder (each level only if missing:
  Infisical writes into no folder that does not exist, and the identity it
  creates is only a project member), and turns an expired session into a
  fresh sign-in link
  (registered with the owner channel, so the next form follows it). A
  hand-over a run has taken is spent: `capture_secret` asked again for it
  opens a new form, never the old "stored" answer.

  The ceremony is also a spec (`packages/hobo-ci/src/ceremony-spec/`): one
  declaration (`CEREMONY`: captures and their links, awaiting codes,
  forbidden wording, the frontier) from which LTLf properties are derived
  (link before form, link before waiting, no dead end, completion follows
  its link, no secret to the host, eventually the frontier). They are
  checked on the JSON-RPC wire (`eventsFromWire`) of the real-binary smoke,
  of every schedule a bounded exhaustive explorer generates (owner choices
  times provider faults, on explicit virtual time) and of fast-check's
  random deeper schedules, shrunk to the smallest failing one
  (`packages/hobo/test/evals/ceremony-explorer.eval.test.ts`). HoBo's two
  browser pages, the secret-capture page and the GitHub App hand-off page,
  are explored by Bombadil against LTL specs (`packages/hobo/test/bombadil/`;
  `browser-pages.bombadil.eval.test.ts`), each also run against a page broken
  on purpose so every property is shown to fail when it should.

  `hobo-mcp` answers the host's `initialize` before the full server has
  loaded (`src/mcp-handshake.ts`, `src/bin/hobo-mcp.ts`): a host waits a
  fixed time for that answer (30 seconds in Claude Code) and gives up on
  the server for the session otherwise, and on a machine that has just
  booted the full server can take longer to load. Every line, `initialize`
  included, reaches the full server once it has loaded, so it still learns
  the host's capabilities; the host gets one answer to `initialize`
  (`test/mcp-cold-start.test.ts`, which holds the load with a module hook,
  not a timer). Under `HOBO_CREDENTIALS=opensesame` the server relaunches
  with stdin passed through, so the early answer is skipped there.

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

## Lint Contract

`npm run docs:cli-lint` scans Markdown command examples and `@hobo/cli`
package summaries. Fenced examples may use only canonical first-level `hobo`
verbs, and package summaries may not list retired verbs. This keeps examples
from reintroducing retired lifecycle, Yard, or Forge drift after this hardening
pass.
