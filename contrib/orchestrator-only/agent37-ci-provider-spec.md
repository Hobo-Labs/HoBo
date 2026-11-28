# Agent37 CI runner provider: spec

Status: draft, research plus spec only. No code pushed, no account created, nothing paid for.
Author: HoBo (Grok Bot executor), 2026-11-20 (America/Chicago).
Repo state inspected: `Hobo-Labs/HoBo` main, shallow clone at `/tmp/hobo-a37` taken 2026-11-20 ~10:40 AM CST.
Agent37 docs read: `https://www.agent37.com/docs/llms.txt` and `llms-full.txt` (Mintlify export), fetched 2026-11-20.

Goal: Agent37 boxes run GitHub Actions jobs, managed by a HoBo controller that works like Actions Runner Controller (ARC): provision on queue demand, register one ephemeral JIT runner per box, tear down after the job, reap orphans and idle boxes, stay inside a budget, and fall back to hosted/ARC. It doubles as the reference for "how to configure a specific hosting provider in HoBo".

---

## 1. Which Agent37

Exactly one credible candidate: **Agent 37 Inc., agent37.com**, a YC F26 company selling "the cheapest sandbox for AI agents".

- Product and API: https://www.agent37.com/cloud, docs at https://www.agent37.com/docs
- YC listing: https://www.ycombinator.com/companies/agent-37 (founder Vishnu Krishnaprasad, Fall 2026)
- LinkedIn and Crunchbase list the same company and domain. No other product named "Agent37" turned up in search.

## 2. Agent37 capabilities (with citations)

### 2.1 What a "box" is
- A box is an **instance**: a persistent sandbox created from a **template**, which is an image. https://www.agent37.com/docs/agents-api/concepts
- There are three instance `type`s (https://www.agent37.com/docs/agents-api/instances/create, https://www.agent37.com/docs/agents-api/billing):
  - `default`: a gVisor-isolated container on shared hardware. It's the cheapest, but sustained CPU "may be limited when the hardware is busy". Runs only in `us`.
  - `vm`: a full VM with its own kernel and KVM, with Docker/Compose/buildx. It costs 2.5x the default compute rate. `agent37-ubuntu` is Ubuntu 26.04 with `dockerd` already running. https://www.agent37.com/docs/agents-api/vm-instances
  - `performance`: a VM with dedicated cores, at 4x the default rate. Meant for builds.
  - `vm` and `performance` "need a funded workspace and take longer to create".
- Shapes (https://www.agent37.com/docs/agents-api/instance-sizing):

  | Shape | Default-type price |
  | --- | --- |
  | 2 vCPU / 4 GB | $4.76/mo (the default) |
  | 4 / 8 | $9.34/mo |
  | 4 / 16 | $15.48/mo |
  | 4 / 32 | $27.76/mo |

  `vm`/`performance` also offer 8 vCPU / 64 GB. Disk costs $0.09/GB-month. Billing is **metered per minute**; a stopped or sleeping box bills disk only. For example, a 2 vCPU `vm` is about $0.00027/min, roughly $0.016 per runner-hour.
- Regions are `us`, `eu`, and `ap-south`, fixed per instance and with no fallback: a full region returns `503 no_capacity`. `eu` and `ap-south` run only `vm` and `performance`. (instances/create)
- Docker inside a `vm` needs `dockerd --data-root "$HOME/docker"`, because the root filesystem is an overlay. systemd isn't supported. (vm-instances)

### 2.2 Free tier and pricing limits
- The $5 starter credit is granted once **after adding a card** in the dashboard. https://www.agent37.com/docs/agents-api/billing
- Concurrency is capped by **memory running at once**: 32 GB on free credit (eight 2 vCPU/4 GB boxes), 40 GB after any top-up, 200 GB at $50 of total top-ups, and so on. Going over returns `409 instance_limit_reached`. Sleeping and stopped boxes don't count. (billing, errors)
- A create needs at least one day of the instance's rate in the wallet, otherwise `402 insufficient_balance`. Creates "debit nothing" until the box runs. https://www.agent37.com/docs/agents-api/errors
- **Implication for HoBo's "no paid tools / no paying for infrastructure" rule:** any real Agent37 use needs a card (for the $5 credit) or a top-up. That is Tyler's decision. The spec keeps everything mock-only until Tyler provides a key and funds the workspace himself. Whether the $5 credit counts as "funded" for `vm` creates is **not documented**.

### 2.3 API (Sandbox API, base `https://api.agent37.com/v1`)
https://www.agent37.com/docs/agents-api/overview

| Need | Endpoint | Notes |
| --- | --- | --- |
| Create | `POST /v1/instances` | Returns 201 once `status: running`. Fields: `template`, `resources{cpu,memory,disk}`, `type`, `region`, `name`, `metadata` (free k/v), `env` (write-only), `budget` (managed-service caps only), `auto_sleep`, `idle_timeout_seconds` (300–86400), `public_ports`, `network` (`allow-all`, `deny-all`, or `{allow:[≤100 domains/IPs]}`), `mount_path`. https://www.agent37.com/docs/agents-api/instances/create |
| List | `GET /v1/instances` | Newest first. **No documented pagination or filter**, so HoBo filters on `metadata` client-side. https://www.agent37.com/docs/agents-api/instances/list |
| Get | `GET /v1/instances/{id}` | Statuses: provisioning, running, stopping, stopped, starting, restarting, updating, sleeping, waking, failed, deleting. https://www.agent37.com/docs/agents-api/instances/object |
| Delete | `DELETE /v1/instances/{id}` | Ends billing. https://www.agent37.com/docs/agents-api/instances/delete |
| Stop / start / sleep / restart / resize / fork / update | `POST /v1/instances/{id}/<verb>` | https://www.agent37.com/docs/agents-api/instance-lifecycle |
| Run a command | `POST https://sandbox.agent37.app/v1/instances/{id}/exec` with header `X-Agent37-Key` | Body `{command, user?: "root", background?: bool, name?: idempotency label}`. Runs via `sh -c`. stdout and stderr are capped at 512 KB each and the body at 1 MB. A synchronous call waits ≤900 s. `name` makes a resend safe for 5 min after finish. https://www.agent37.com/docs/agents-api/exec |
| Startup scripts | Boot hooks `~/.agent37/hooks/post-image-update.sh` (≤15 min) and `post-restart.sh` (≤5 min) | They run as the image user (not root) with instance env. **No cloud-init / user-data field on create.** https://www.agent37.com/docs/agents-api/instance-lifecycle |
| Env | `env` on create | "write-only: it is not returned by `GET /v1/instances/{id}`". https://www.agent37.com/docs/agents-api/instance-environment |
| Images | System templates (`agent37-base`, `agent37-ubuntu`, ...) or workspace templates | Workspace templates come from a registry `image_ref` (pinned by digest) or a cloud build (`npx agent37 templates build`). Cloud builds and outside-registry templates need a funded wallet. https://www.agent37.com/docs/agents-api/templates, https://www.agent37.com/docs/agents-api/custom-image |
| Webhooks | `POST/GET/DELETE /v1/webhooks` | Fires on every instance status change. Signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature` HMAC-SHA256, `whsec_` secret shown once). Max 5 per workspace, HTTPS public host only. https://www.agent37.com/docs/agents-api/webhooks |
| Logs / metrics | `GET .../logs`, `.../metrics` | https://www.agent37.com/docs/agents-api/logs, https://www.agent37.com/docs/agents-api/metrics |
| Usage | `GET /v1/usage?from&to` | Spend by day, instance, and model; compute is settled hourly. (billing) |
| SSH | `POST/GET/DELETE /v1/ssh-keys` (public keys only) | Tunnels over a WebSocket through `agent37 tunnel` (`ProxyCommand`). https://www.agent37.com/docs/agents-api/ssh |
| Errors | Stable machine codes | Retry-safe: `no_capacity` (503), `try_again` (409), `provisioning_failed` on create. https://www.agent37.com/docs/agents-api/errors |

- **Rate limits:** the only documented 429s are backups (once per 15 min per instance) and upstream model limits on the Agent API. **No general Sandbox API rate limit is documented.** HoBo should still apply client-side token-bucket limits and honor `Retry-After`. (errors)
- **Create latency:** **not documented.** VM creates are "longer". This needs measurement before Agent37 can sit on the required-gate path.
- **CLI / SDK:** the `agent37` npm CLI (template builds, SSH) https://www.npmjs.com/package/agent37, a one-file Python SDK https://www.agent37.com/docs/python-sdk, a docs MCP server, and an agent skill. https://www.agent37.com/docs/for-agents. There is no official Node SDK; HoBo should call the REST API directly over the bounded fetch transport.
- **Isolation:** gVisor per sandbox, egress firewalled to the public internet, ingress only through Cloudflare with the API key. https://www.agent37.com/ (marketing page)

### 2.4 Auth: exactly what exists
| Method | Supported? | Evidence |
| --- | --- | --- |
| **API key** `sk_live_...` | **Yes, the only documented credential for the Sandbox API.** Send `Authorization: Bearer` on `api.agent37.com` and `X-Agent37-Key` on `*.agent37.app` (exec, instance URLs, SSH tunnel). | https://www.agent37.com/docs/agents-api/concepts ("Two planes, one key") |
| Where keys are created | Dashboard **https://www.agent37.com/dashboard/cloud/api-keys**. Keys are minted and revoked there. "There is no endpoint that mints keys, on purpose." | https://www.agent37.com/docs/agents-api/signup, https://www.agent37.com/docs/agents-api/members |
| Key scopes | **None documented.** Each key is "scoped to one workspace" and is "a full workspace key": it creates instances, manages templates and domains, reads usage, **funds the wallet**, and **adds members**. Docs say to treat it "as able to spend money". | signup, concepts |
| Key expiry | **Not documented.** Keys appear to last until revoked. | (absence) |
| OAuth (auth code / PKCE / device) for the Agent37 API | **Not documented. None found.** OAuth appears only for third-party apps inside instances (Composio integrations), the Codex device login inside an instance, and a Claude Code OAuth token as instance env. None of these authenticates to Agent37. | https://www.agent37.com/docs/agents-api/integrations, https://www.agent37.com/docs/agents-api/codex |
| OIDC federation (e.g. trusting GitHub Actions OIDC tokens) | **Not documented. None found.** No workload-identity or token-exchange endpoint exists. | (absence across llms-full.txt) |
| Programmatic signup | `POST /v1/signup` (unauthenticated) creates a **new workspace** plus key and returns a `claim_url` and a Stripe `top_up_url`. **HoBo must not use this**: it creates an account, which is out of bounds. | signup |
| SSH keys | Public keys registered by API, only for interactive SSH, and still gated by the API key through the tunnel. Not a control-plane credential. | ssh |
| Signed URLs | Time-boxed browser access to an instance port. Can't authorize exec. | https://www.agent37.com/docs/agents-api/urls |
| Webhook secret | `whsec_...`, returned once at webhook creation. HoBo stores it in the secret store. | webhooks |

**Conclusion: Agent37 is an API-token-only provider, and the token is full-power and has no scopes.** The provider-specific auth chain therefore has one real first choice (a dedicated API key, captured out of band), plus manual and secret-store fallbacks. The design reserves OIDC/OAuth slots so they turn on if Agent37 ever ships them.

---

## 3. Current HoBo state (repo inspection)

### 3.1 How providers and deployment targets are modeled
- **Hosting providers (CD):** `packages/providers/provider-<name>/` packages publish a capability manifest (`src/manifest.ts` → `/.well-known/capability-manifest/{index,capabilities,auth,cost}.json`). See `provider-hostinger/src/manifest.ts`, whose auth document is `mode: "svid-federation"`, `staticSecrets: false`, exchange `hobo:broker-credential-locator`.
- `packages/hobo/src/provider-hosting-catalog.ts` is the deployable platform registry. `HostingProviderCatalogEntry` is a union of `TokenEntry<"hetzner"|"hostinger"|"vercel"|...>`, each built from a **verified lease** (`pinnedCredential(entry.lease)`); there is no ambient credential lookup. `MANIFEST_IDS` and `PROVIDER_DELIVERY_COVERAGE` (ADR-0182 I14) list every `packages/providers/*` package.
- **Broker connector registry** (`packages/broker/src/connector-registry.ts`): kinds are `github-app | pulumi | azure | vercel | cloudflare | custom`, with `REQUIRED_SETTINGS` per kind. It holds only `credentialRef`; credentials live in the token broker or secret store.
- **Connections** (`hobo connection create|authorize|...`, `packages/hobo/src/connection-command.ts` → `packages/management/src/connection-ops.ts`): `ConnectionFlow = oidc-federation | oauth2-xaa | oauth2-obo | device-code | api-key | app-install` (`packages/identity/src/connection-events.ts`). The default flow is `oauth2-obo`. There is **no Agent37 provider definition** of any kind.
- **Credential custody for the CLI:** with `HOBO_CREDENTIALS=opensesame` (ADR-0170, `packages/hobo/src/credentials-opensesame.ts`), `hobo.credentials.json` holds references only, and OpenSesame relaunches `hobo` with an `osr_` surrogate (today `VERCEL_TOKEN` / `PULUMI_ACCESS_TOKEN`).

### 3.2 CI runner pools and routing
- `.hobo/ci.json` → `environments.<env>.policy.providers[]` has kinds validated by `packages/ci-gh-actions/schema/ci-project-providers.schema.json`, `packages/ci/src/policy.ts` (`providers` set), `packages/ci/src/config.ts` (offer validation) and `packages/ci/data-models/ci.cue`: `github, blacksmith, depot, warpbuild, kubernetes (scaleSet{name,namespace,minRunners,maxRunners}), hobo-box-worker, local, vercel (location), azure-devops, dagger, cloudflare`. The `ci` env today has `vercel-sandbox`, `oracle-free-isolated` (hobo-box-worker), `github-hosted` (disabled), and `hostinger-arc` (kubernetes, disabled, maxRunners 4).
- `runnerRouting` (`packages/ci-gh-actions/src/runner-routing.ts`, mirrored in `scripts/ci/runner-routing.mts` and `onboarding.cue`) has `labels{fleet,trunk,local,github,box}`, `externalPools[{labels,runnerNamePrefix,maxRunners}]` (empty today), queue limits, and verdict thresholds.
- `integrations[]` holds third-party runner vendors (blacksmith, depot, jog, boat), with `auth.method ∈ github-app | oidc | device | secret-ref`.
- `scripts/ci/route-runner.mts` `main()`:
  - A `merge_group` run on `hobo-ci.yml`/`release-hobo.yml` in `auto` mode **always** returns `tier: "github"`, with the hard-coded reason "no verified fleet capacity".
  - A `pull_request` batch consults the injected `PrBatchCapacityVerifier(scope)`, which nothing currently supplies, so it falls back to hosted. This is the hook the routing lane is filling with a probe-pickup-based capacity check.
- **JIT runner minting and the closest analog: Vercel Sandbox.**
  - `packages/ci-vercel/src/sandbox-controller.ts` `createSandboxController({store, github, driver: IsolatedSandboxDriver, authorize, charge, assignment, unmet, reportFailure})` runs the phases authorize → guest_create → configure_egress → runner_prepare → reauthorize → jit_register → runner_start → cleanup. It also includes `recoverRunner()` for lost JIT responses, and leases with durable intent and settlement.
  - `IsolatedSandboxDriver` is `create / discover / prepare / start(jit) / inspect / stop → SandboxUsage`.
  - `sandbox-runner-bootstrap.ts`: `PREPARE_SANDBOX_RUNNER` (pinned runner tarball and SHA256), then `START_SANDBOX_RUNNER`. The JIT goes into a 0600 file through `writeFiles` and is read and deleted in-VM. It is never placed in argv or env.
  - The relay hosts this through `IsolatedRunnerHost.launch/reconcile` (`packages/ci-gh-actions/src/hosted-relay.ts`). The relay is `hobo-ci.vercel.app`, currently 503, and is meant to be redeployed by HoBo CD (#2388), never by a Git link.
  - **An Agent37 driver can implement `IsolatedSandboxDriver` almost one-to-one.** That is the core of this spec.
- Test infrastructure: `testcontainers@11.8.1` is already a devDependency of `@hobo/ci` and `@hobo/ci-gh-actions`. `packages/ci-vercel/test/sandbox-controller.test.ts` drives the controller with a fake driver. mirror.cloud is a pinned sibling emulator binary (ADR in `docs/design/adr/01-architecture-core.md` §pins).

### 3.3 The hobo / hobo-ci MCP surface today
- **Binary:** `hobo-mcp` (`packages/hobo/bin/hobo-mcp.ts` → `packages/hobo/src/mcp-serve.ts` `composeHoboMcp`). `hobo-ci` is a CLI only (`packages/hobo-ci/src/cli.ts`); there is **no separate hobo-ci MCP server**. Its ceremonies run inside `hobo-mcp` through the owner channel.
- **Tools:**
  1. One tool per canonical CLI verb (`packages/cli/src/shell/verbs.ts` `CANONICAL_VERBS`, parity enforced by `packages/mcp/src/tool-surface.ts`): `up down dev new login connection identity trails access feature deploy ci cd incident claim recipes offer plan verify can-deploy inspect logs doctor messaging codegen build collect stub drift add registry import generate sandbox test attest erase broker yard station serve replay derivative runbook`.
  2. Secret capture (`packages/mcp/src/secret-capture/app.ts`): `capture_secret {name, writerClientId?, channel?, replace?}`, `submit_secret_value` (app-only), `secret_capture_status`, `end_secret_capture`.
  3. Store choice (`packages/hobo/src/mcp-store-choice.ts`): `choose_secret_store`, `submit_store_choice`.
- **Elicitation in use:**
  - **URL mode** (`URLElicitationRequiredError -32042` plus `notifications/elicitation/complete`) for secret capture on a local host. The page is served on `127.0.0.1` (`loopback.ts`) and the value is sealed with ECDH-ES/AES-GCM (`seal.ts`).
  - An **MCP Apps** form (`ui://hobo/secret-capture`) when the host supports MCP Apps.
  - **Form mode** for the store choice. It asks for non-secret fields only: `store` enum, then `INFISICAL_PROJECT_ID` | `OP_VAULT_ID` + `OP_CONNECT_HOST` | `BITWARDEN_SERVER_URL`.
  - Form-mode `confirm` (link plus "Done") for device-code style steps, and URL-mode `show` for Vercel's device code (`mcp-owner-channel.ts`).
  - **Form mode for a secret value on a remote box** (`app.ts` channel `"form-elicitation"` → `askInForm`) when the host lacks MCP Apps. **This conflicts with MCP 2025-11-25** ("Servers MUST NOT use form mode elicitation to request sensitive information", https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) and with the package README ("Form-mode elicitation is never used").
- **What is captured today, per provider or secret:**

  | Capture | Fields | Mode | Stored where |
  | --- | --- | --- | --- |
  | Relay specs (`mcp-secret-capture.ts` `RELAY_SECRET_CAPTURE_SPECS`) | `INFISICAL_WRITER_CLIENT_SECRET` (one-use writer secret), `VALKEY_URL`, `TURSO_AUTH_TOKEN` | MCP App / URL / (remote) form | Infisical, via a one-use writer identity `hobo-secret-writer`; the token is revoked after ≤15 min |
  | Owner hand-offs (`mcp-owner-channel.ts` `OWNER_HANDOFF_SPECS`) | `INFISICAL_CLI_SESSION`, GitHub App code, Bitwarden client_id + client_secret, 1Password email + Secret Key + password, `HOBO_CI_PUBLIC_URL`, `HOBO_CI_GITHUB_OWNER` | Same channels | Held in process memory, taken once; never a store or file |
  | Store choice | Store, plus that store's non-secret ids | Form | Committed binding (non-secret) |
  | Vercel (CI relay) | No token (device code / OIDC) | URL prompt | n/a |
  | Hetzner / Hostinger / DO / etc. (CD) | **Nothing through MCP.** Credentials arrive as verified leases from the broker / OpenSesame / env. | n/a | Token broker / OpenSesame |
  | **Agent37** | **Nothing. No spec, no provider, no prompt.** | n/a | n/a |

- **PRs #2388 / #2598** (both OPEN, draft):
  - #2388 "Deliver the hosted CI relay through HoBo CD", head `6d5ff8c57`, touches the `hobo-deploy` skill and `packages/cd-vercel/src/store.ts`.
  - #2598 "Keep owner-store setup in private handoffs", head `9d6c2a433`, touches `packages/hobo/src/mcp-owner-channel.ts`, `packages/mcp/src/secret-capture/html.ts`, `packages/hobo-ci/src/{owner-channel,owner-store,prepare,bitwarden-*,onepassword-access,isolated-owner-*}.ts`, and `packages/hobo-cd/src/prepare.ts`.
  - Neither adds provider auth beyond secret stores. The Agent37 work should land **after #2598**, because it edits the same owner-channel and capture files.

---

## 4. Provider definition (config as code)

### 4.1 Broker connector kind
Add `agent37` to `CONNECTOR_KINDS` (`packages/broker/src/types.ts`) with `REQUIRED_SETTINGS.agent37 = ["workspaceId"]`. `credentialRef` points at the secret store, e.g. `infisical://<project>/<env>/ci/AGENT37_API_KEY`.
```json
{ "id": "agent37-ci", "kind": "agent37",
  "settings": { "workspaceId": "ws_…", "apiOrigin": "https://api.agent37.com", "execOrigin": "https://sandbox.agent37.app" },
  "credentialRef": "secret-store:ci/AGENT37_API_KEY",
  "webhookSecretRef": "secret-store:ci/AGENT37_WEBHOOK_SECRET" }
```
`workspaceId` is used only for display and checks; Agent37 derives the workspace from the key. It is optional if the key can't be introspected. **There's no documented whoami endpoint** (`GET /v1/billing` returns the tier but its docs don't promise a workspace id), so the first PR verifies the key with `GET /v1/billing` or `GET /v1/instances` only.

### 4.2 Provider package `packages/providers/provider-agent37`
- `manifest.ts`: capability `ci/runner` (and optionally `web/service` later). The auth document is honest:
  `{ mode: "static-api-key", staticSecrets: true, scopes: "workspace-full", rotation: "manual-dashboard", oidc: false, oauth: false, keyPage: "https://www.agent37.com/dashboard/cloud/api-keys" }`.
  The cost document derives per-minute prices from the instance-sizing table, with `transcribedOn: 2026-11-20` and `pricingStatus: "estimate"`.
- `transport.ts`: bounded fetch over `createBoundedFetchTransport` with an origin allowlist of `api.agent37.com` and `sandbox.agent37.app` only, so a config value can't redirect the key, matching Hostinger's transport rule. Retries go only on `no_capacity`, `try_again`, or 5xx, with jitter and `Retry-After` honored.
- `client.ts`: `createInstance`, `getInstance`, `listInstances`, `deleteInstance`, `exec({command,user,background,name})`, `registerWebhook`, `listWebhooks`, `deleteWebhook`, `usage`. Every response is zod-parsed. Redaction comes from `@hobo/provider-redaction`.
- Registered in `PROVIDER_DELIVERY_COVERAGE` as `refused` for delivery ("CI runner provider; bound by the CI policy, not a hosting target") until a CD use exists. **No Git linking anywhere; CD for HoBo itself remains HoBo CD.**

### 4.3 CI provider kind `agent37` in `.hobo/ci.json`
Add `Agent37Provider` to `ci-project-providers.schema.json`, `packages/ci/src/policy.ts` `providers`, the `config.ts` offer validation, and the `ci.cue` `#Provider.kind`:
```json
{
  "id": "agent37-runners",
  "kind": "agent37",
  "connectionRef": "agent37-ci",
  "runsOn": "hobo-agent37",
  "enabled": false,
  "pool": {
    "minBoxes": 0,
    "maxBoxes": 4,
    "type": "vm",
    "size": { "cpu": 2, "memory": 4, "disk": 20 },
    "region": "us",
    "template": "agent37-ubuntu",
    "idleTtlSeconds": 600,
    "jobTimeoutSeconds": 1800,
    "labels": ["hobo-agent37"],
    "network": { "allow": ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "pkg-containers.githubusercontent.com", "*.actions.githubusercontent.com", "ghcr.io", "registry.npmjs.org"] },
    "budget": { "limitMicros": 2000000, "period": "month", "maxCreatesPerHour": 60 }
  }
}
```
Field rules (zod, CUE, and JSON Schema must agree on fixtures):

| Field | Rule |
| --- | --- |
| `type` | `default`, `vm` or `performance`. Jobs that need Docker (service containers, `container:` jobs, buildx) require `vm`. |
| `size` | Must be one of the documented shapes; disk is a whole number of GB in the shape's range. |
| `region` | `us`, `eu` or `ap-south`. Non-`us` requires `type ≠ default`. |
| `template` | A system template, or a workspace template pinned as `name@revision`. A pinned runner image is recommended (PR 7). |
| `idleTtlSeconds` | 60–3600. Applies to warm boxes held for `minBoxes`; one-job boxes are deleted, not slept. |
| `maxBoxes × memory` | Refused at parse time if it exceeds the 32 GB free-tier ceiling, unless `allowAboveFreeTier: true`. |
| `budget.limitMicros` | Enforced by HoBo's budget authority (the existing `policy.budget` path) **before** any create. Agent37's own `budget` field covers only managed LLM/search spend, so it is always sent as `0/0`. |
| `network.allow` | ≤100 entries, the Agent37 limit. Default deny for anything else, which limits exfiltration from PR code. A leading `*.` label wildcard is supported (`*.github.com` matches the apex and every name under it). Domain entries cover HTTPS on port 443 only; other ports need IP entries. https://www.agent37.com/docs/agents-api/instance-network |

Add a `runnerRouting.externalPools` entry so route-runner knows the label exists:
`{ "labels": ["hobo-agent37"], "runnerNamePrefix": "hobo-a37-", "maxRunners": 4 }`.

---

## 5. Controller design ("ARC for Agent37")

### 5.1 Where it runs
- **Primary: the hosted relay** (`packages/ci-vercel`), next to the Vercel Sandbox controller. It reuses `HostedRelayStore` leases, GitHub App JIT minting, `workflow_job` webhooks, cron sweeps (`CRON_SECRET`), and budget settlement. The relay is deployed only by HoBo CD (#2388), never Git-linked.
- **Secondary: `hobo ci serve`** (`packages/ci-gh-actions` pull admission) for local/dev and for running the controller off the relay while the relay is down (it is 503 today). The driver and controller are transport-agnostic, so both hosts compose the same `createSandboxController` with an `Agent37SandboxDriver`.

### 5.2 Driver: `Agent37SandboxDriver implements IsolatedSandboxDriver`
| Driver call | Agent37 implementation |
| --- | --- |
| `create(config)` | `POST /v1/instances` with `{template, type, region, resources, name: "hobo-a37-<leaseId8>", metadata: {hobo:"ci", pool, leaseId, repo, runId, jobId, createdBy:"hobo-relay", expiresAt}, env: {HOBO_LEASE_ID}, network, auto_sleep: false}`. Idempotent per lease: before creating, `discover()` checks for an existing instance with `metadata.leaseId`. Returns `{name: id, sessionId: id, expiresAt}`. |
| `discover(name)` | `GET /v1/instances/{id}`, falling back to a `GET /v1/instances` scan filtered by `metadata.leaseId`. |
| `prepare` | `exec` as root with `name: "prep-<leaseId>"` (idempotent resend): start `dockerd --data-root $HOME/docker` on `vm`, download the **pinned** runner tarball (`RUNNER_URL`, `RUNNER_SHA256` from `packages/ci-gh-actions/src/bootstrap.ts`), check the sha256, extract, and create the user `runner`. The script is constant: no workflow data or credentials are interpolated. If the pool uses a prebaked template, this collapses to a verify-only step. |
| `start(jit)` | One `exec` with `name: "start-<leaseId>"` and `background: true` whose command is a constant heredoc: write stdin-like payload → `umask 077; cat > ~/.hobo-ci-jit` → `START_RUNNER` (the same one-shot `mkdir .hobo-ci-started` guard, read-then-delete, `env -i ... ./run.sh --jitconfig "$jit"`). The JIT travels **only in the HTTPS exec request body**: not argv of any long-lived process, not instance `env`, and not logs. Validated as base64 ≤256 KiB like `startSandboxRunner`. See the 5.5 risk note. |
| `inspect(cmd)` | `exec` `kill -0 <pid>; cat ~/.hobo-ci-exit 2>/dev/null` (the runner wrapper writes its exit code), plus `GET` status. A `failed`/`deleted` status is terminal. |
| `stop()` | `DELETE /v1/instances/{id}`. Usage = (running minutes × shape rate) from timestamps, reconciled later against `GET /v1/usage` per instance (hourly settlement). |

### 5.3 Reconcile loop
Triggers: GitHub `workflow_job` webhooks (queued/in_progress/completed) already received by the relay, Agent37 status webhooks (Standard Webhooks, verified with `AGENT37_WEBHOOK_SECRET`), and a 1-minute cron sweep as the safety net.

```
desired = clamp(queuedJobsFor(label) + minBoxes - idleWarm, 0, maxBoxes)
        ∧ budgetAuthority.canSpend(estimate(shape, jobTimeout))
        ∧ memoryInUse + shape.memory ≤ workspaceMemoryLimit
for each missing slot: lease = reserve(job) → driver.create → prepare →
        mint JIT (POST /repos/{repo}/actions/runners/generate-jitconfig, labels=[runsOn], name=hobo-a37-<lease>, runner_group) → start
on workflow_job.completed for runner name hobo-a37-*: driver.stop → settle charge
on instance status failed: release lease, mark unmet → re-queue to fallback
sweep:
  - orphan instances: metadata.hobo=="ci" and (no live lease or now > metadata.expiresAt) → DELETE
  - orphan runners: GitHub runners named hobo-a37-* with no instance → DELETE runner (reuse recoverRunner())
  - stuck: provisioning/prepare > 10 min or assigned-but-silent > jobTimeout → DELETE + requeue
  - idle warm boxes past idleTtlSeconds → DELETE (never sleep: a slept runner can't take jobs)
```

- **Ephemeral:** one box, one JIT runner, one job, then delete. Boxes are never reused; this mirrors `START_SANDBOX_RUNNER`'s "never on a reused sandbox" rule.
- **Scale limits:** `maxBoxes`, the HoBo budget (`limitMicros` per period, checked before every create using shape rate × `jobTimeoutSeconds` as the reservation and settled on actual minutes), `maxCreatesPerHour`, and the workspace memory ceiling. A `409 instance_limit_reached` or `402 insufficient_balance` turns the provider **unhealthy** for 10 minutes and stops creates.
- **Fallback:** if the provider is unhealthy or create fails (`no_capacity`, 402, 409, timeout > `queue.maxWaitSeconds`), the lease's `unmet(job)` hands the job back. Route-runner then picks hosted (`ubuntu-24.04`) or ARC (`hobo-arc`) on the next run, and the relay's existing "no eligible provider → queue" policy applies. A job already routed to `hobo-agent37` that can't get a box within `maxWaitSeconds` is covered by the existing route-slip timeout and requeue.

### 5.4 Plugging into route-runner
- The routing lane's capacity check (probe-pickup-based, filling `PrBatchCapacityVerifier` and removing the hard-coded merge-group hosted branch) gets an Agent37 capacity source: `agent37Capacity(pool) = healthy ∧ budgetRemaining ≥ reserve ∧ (maxBoxes - active) ≥ jobsInBatch`. It reports an **independently verified** reservation: the controller pre-reserves leases for the batch, so it is a claim, not a queue observation, which satisfies the verifier contract comment in `route-runner.mts`.
- Ordering (committed in `runnerRouting`): `fleet (ARC) → agent37 → github`. Agent37 is used **first for jobs that aren't required checks** (release, relay deploy, pricing). The required gate moves to Agent37 only after measured p50 create+prepare is < 60 s and its failure rate is < 1% over 50 runs.

### 5.5 Security notes
- PR code runs on boxes in Tyler's Agent37 workspace. Mitigations:
  - `network.allow` egress allowlist.
  - A dedicated workspace just for CI (recommended), so a leaked key can't touch other instances.
  - The key never enters the box. Agent37's edge strips `X-Agent37-*` before forwarding, per the urls docs, and HoBo never puts the key in instance `env`.
  - Fork PRs keep using the existing `forkPullRequestEnvironment` policy and never route to Agent37.
- **JIT transport risk:** Agent37 has no file-write endpoint on non-agent templates (the `/v1/files` API belongs to agent templates). So the JIT has to go in an `exec` body or over SSH/scp. Whether Agent37 logs exec command bodies is **not documented**. Mitigation: JIT configs are single-use and short-lived, and the start script deletes the file before exec'ing the runner. Phase 2 option: **pull mode**. The box gets a one-time, per-lease bootstrap nonce in write-only `env` (sha256 stored at the relay, TTL 10 min, single use) and fetches its JIT from a new relay endpoint `POST /v1/agent37/claim/{leaseId}`, modeled on `HostedRelay.claim`. That keeps the JIT out of every Agent37 API body.
- Logs and telemetry carry only lease ids, phase names, and sanitized HTTP status (same rule as `SandboxLaunchFailure`). The key, JIT, and webhook secret are never logged.

---

## 6. Auth UX with provider-specific fallbacks

### 6.1 Ordered chain for Agent37 (based on what Agent37 actually supports)
| # | Method | Agent37 status | Behavior |
| --- | --- | --- | --- |
| 1 | OIDC federation (GitHub Actions OIDC → Agent37) | **Unsupported (undocumented)** | Skipped. The manifest declares `oidc: false`; HoBo probes nothing. Kept as a declared slot so a future Agent37 feature only flips the manifest. |
| 2 | OAuth (auth-code+PKCE via URL elicitation, or device code) | **Unsupported (undocumented)** | Skipped, with `oauth: false`. |
| 3 | **API key, captured out of band** | **Supported, and the primary path** | The owner creates a dedicated key in the dashboard and pastes it into HoBo's **capture page via URL-mode elicitation**, or the MCP App form on MCP-Apps hosts. The value goes straight to the secret store. |
| 4 | Existing secret-store entry | Supported | If `ci/AGENT37_API_KEY` already exists in the bound store (Infisical / 1Password / Bitwarden), HoBo just verifies it. Nothing is prompted. |
| 5 | Manual env (CI and headless) | Supported | `AGENT37_API_KEY` in the relay's runtime secret-store binding, or a GitHub environment secret for `hobo ci serve`. The owner sets it themselves; HoBo prints instructions only. |

**Deviation from the brief:** the brief asked for "API token through MCP **form** elicitation". MCP 2025-11-25 forbids form mode for secrets. So the token goes through **URL mode** (HoBo's sealed capture page) or the **MCP App**. Form mode carries only the non-secret pool settings (6.3). On a remote box whose host offers neither URL mode nor MCP Apps, HoBo refuses with instructions (path 5) rather than using a form. That also means the existing `"form-elicitation"` secret channel needs fixing (section 7).

### 6.2 Which tool triggers it
- `hobo ci connect agent37` (new subcommand of the existing `ci connect`), reachable as the `ci` MCP tool with args `["connect","agent37"]`.
- Any `hobo ci up` / `hobo ci deploy` / route that resolves a provider with `kind: "agent37"` and finds `connectionRef` unresolved. It calls `ownerChannel.captureSecret({name: "AGENT37_API_KEY"})` before the first Agent37 call, the same pattern the GitHub App code capture uses.
- Directly: `capture_secret {name: "AGENT37_API_KEY"}`, and `capture_secret {name: "AGENT37_WEBHOOK_SECRET"}` (normally automatic, see 6.4).

### 6.3 Exact elicitation payloads

**(a) Pool settings, form mode, non-secret only** (sent by `hobo ci connect agent37` when `.hobo/ci.json` has no `agent37` provider):
```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "Set up Agent37 boxes as CI runners. Nothing here is secret; the API key is asked for separately.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "region":   { "type": "string", "title": "Region", "enum": ["us","eu","ap-south"], "enumNames": ["US","EU (France/UK)","India (Mumbai)"], "default": "us" },
        "type":     { "type": "string", "title": "Box type", "enum": ["vm","default","performance"], "enumNames": ["VM (Docker jobs) 2.5x","Container (no Docker) 1x","Performance (dedicated cores) 4x"], "default": "vm" },
        "size":     { "type": "string", "title": "Size", "enum": ["2x4","4x8","4x16"], "enumNames": ["2 vCPU / 4 GB","4 vCPU / 8 GB","4 vCPU / 16 GB"], "default": "2x4" },
        "maxBoxes": { "type": "integer", "title": "Max boxes at once", "minimum": 1, "maximum": 8, "default": 4 },
        "monthlyBudgetUsd": { "type": "number", "title": "Monthly budget cap (USD)", "minimum": 0, "maximum": 100, "default": 2 },
        "dedicatedWorkspace": { "type": "boolean", "title": "This is a workspace used only for CI", "default": true }
      },
      "required": ["region","type","size","maxBoxes","monthlyBudgetUsd"]
    }
  }
}
```
On accept, HoBo writes the provider entry into `.hobo/ci.json` as a **proposed diff** (with `enabled: false`) for the owner to commit. Nothing is pushed.

**(b) API key, URL mode** (local host or client with `elicitation.url`). This is returned as a JSON-RPC error from the triggering tool call:
```json
{
  "jsonrpc": "2.0", "id": 7,
  "error": {
    "code": -32042,
    "message": "Agent37 needs an API key before HoBo can start CI boxes.",
    "data": {
      "elicitations": [{
        "mode": "url",
        "elicitationId": "cap_<ticket>",
        "url": "http://127.0.0.1:<port>/capture/cap_<ticket>",
        "message": "Create a key at https://www.agent37.com/dashboard/cloud/api-keys (name it hobo-ci; use a CI-only workspace — Agent37 keys can't be scoped and can spend the wallet), then paste it on this page. It goes straight to your secret store."
      }]
    }
  }
}
```
The capture page (`html.ts`) shows the deep link as a button, a `sk_live_` field, and the scope warning. After the store write, HoBo sends `notifications/elicitation/complete {elicitationId}`. On MCP-Apps hosts the same spec renders inside `ui://hobo/secret-capture` instead.

**(c) Capture spec** added to a new `PROVIDER_SECRET_CAPTURE_SPECS` (target `runtime`, written to the relay's store binding under `ci/`):
```ts
secretCaptureSpec({
  name: "AGENT37_API_KEY",
  target: "runtime",
  label: "Agent37 API key (sk_live_…)",
  purpose: "Lets HoBo create and delete CI runner boxes in your Agent37 workspace. Full-workspace key: use a CI-only workspace.",
  minBytes: 16, maxBytes: 256,
  charset: "printable-line",
  pattern: "^sk_live_[A-Za-z0-9_-]{8,248}$",   // prefix documented; body charset/length not documented, so pattern stays permissive
  link: { url: "https://www.agent37.com/dashboard/cloud/api-keys", message: "Create an Agent37 API key" },
})
```

**(d) Remote host without URL mode or MCP Apps:** the tool result refuses (no form). Code `HOBO_AGENT37_KEY_NEEDS_SAFE_CHANNEL`, with remediation: "Put AGENT37_API_KEY into your secret store yourself (path: ci/AGENT37_API_KEY), or rerun from a host that supports MCP Apps or URL elicitation."

### 6.4 After capture
1. Verify with `GET /v1/instances` (read-only). On 401, mark the connection `needs-reauth` and offer a fresh capture.
2. Register the status webhook: `POST /v1/webhooks {url: "<relay>/v1/agent37/webhook"}`. The returned `whsec_` secret goes **directly from the response into the secret store** (`ci/AGENT37_WEBHOOK_SECRET`) and is never shown. Only one HoBo webhook is created, which leaves room under the 5-per-workspace limit.
3. Record the Connection: `flow: "api-key"`, `status: "active"`, `credentialRef` set. **No value goes to the repo, the chat, logs, or the tool result**, only `{stored: true, ref}`.
4. Rotation means a new dashboard key, then `capture_secret {name: "AGENT37_API_KEY", replace: true}`, then revoking the old key in the dashboard (manual: there's no revoke API).

### 6.5 Test secrets
All tests generate a synthetic `sk_live_` + `randomBytes(24).toString("base64url")` at runtime, in memory only, never written to disk or fixtures. They reuse the capture tests' leak watch (raw, JSON-escaped, base64, and 16-char-slice scans over every output). The fake webhook secret is `whsec_` + a random base64 32 bytes.

---

## 7. Gaps in the current MCP collection flow, and the changes needed

| Gap | Change | Files / functions |
| --- | --- | --- |
| No Agent37 (or any CI runner provider) credential spec | Add `PROVIDER_SECRET_CAPTURE_SPECS` (`AGENT37_API_KEY`, `AGENT37_WEBHOOK_SECRET` as an internal non-prompt deposit) and include them in `createOwnerCaptureApp` specs | `packages/hobo/src/mcp-secret-capture.ts`, `packages/hobo/src/mcp-owner-channel.ts` `createOwnerCaptureApp` |
| Capture specs can't carry a deep link to the provider's token page | Add an optional `link {url,message}` to `secretCaptureSpec` and render it as `linkField` on the page and in the MCP App. Today links come only from `owner.linkFor()` set by a running ceremony | `packages/mcp/src/secret-capture/spec.ts`, `html.ts`, `app.ts` |
| **Secret values are asked via form-mode elicitation on remote boxes** (`channel = "form-elicitation"` → `askInForm`) | Remove form mode for secrets. Remote hosts with `elicitation.url` get URL mode pointing at a **relay-hosted** capture page (not `127.0.0.1`), sealed to the process's ECDH key. Otherwise refuse (6.3d). Also fix the README/code mismatch. Coordinate with #2598, which edits the same files | `packages/mcp/src/secret-capture/app.ts` (channel selection ~L755, `askInForm`), `loopback.ts` → a remote-capture origin, `packages/hobo/src/mcp-serve.ts` `forms()` |
| No provider-auth chain abstraction: each ceremony hard-codes its flow | Add `ProviderAuthChain` (`oidc → oauth-url → oauth-device → api-key-capture → existing-store → manual-env`) driven by the provider manifest's auth doc, so Agent37 declares `oidc:false, oauth:false` and the chain skips straight to API-key capture | new `packages/hobo-ci/src/provider-auth-chain.ts`; manifest auth schema in `@hobo/core` (`AUTH_SCHEMA`) gains `methods[]` |
| `hobo ci connect` only knows `github` | Add `connect agent37` (and a generic `connect <provider>` that reads the chain) | `packages/hobo/src/ci-command.ts` (positionals at ~L449–490) |
| Store connector writes only to the relay's Infisical binding (`createInfisicalCaptureConnector`) | Allow `target: "runtime"` specs under a `ci/` folder path; 1Password/Bitwarden connectors once #2598 lands | `packages/hobo/src/mcp-secret-capture.ts`, `ci-secret-store.ts` |
| Broker connector kinds lack `agent37` | Add the kind and its required settings | `packages/broker/src/types.ts`, `connector-registry.ts` |
| CI provider schema lacks `agent37` | Add `Agent37Provider` + `pool` to the JSON Schema, zod, CUE, policy and offer validation; add fixtures valid/invalid | `packages/ci-gh-actions/schema/ci-project-providers.schema.json` (generated), `packages/ci/src/policy.ts`, `packages/ci/src/config.ts`, `packages/ci/data-models/ci.cue` (+fixtures), `packages/ci/src/fleet/offers.ts` |
| Store-choice form has no "where should provider keys go" | Not needed: provider keys follow the chosen store. Document it in the `hobo-deploy` skill | `.agents/skills/hobo-deploy/SKILL.md` |

---

## 8. PR plan (small, ordered, each with tests; no real Agent37 calls unless credentials are present)

| # | PR | Contents | Tests |
| --- | --- | --- | --- |
| 1 | **Agent37 API fake** | `packages/providers/provider-agent37/test/fake/`: an in-process HTTP fake of the documented endpoints (instances CRUD and lifecycle, exec sync/background/`name` idempotency, webhooks with Standard Webhooks signing, error codes `402/409/503/429`, memory ceiling) plus a tiny Testcontainers image wrapper (`node:24-alpine` running the same fake) for cross-process contract tests. Shaped so it can later become a mirror.cloud provider. | Fake self-tests against doc-derived fixtures |
| 2 | **provider-agent37 client and transport** | `client.ts`, `transport.ts` (origin allowlist, retry policy), `manifest.ts` (auth doc `static-api-key`, cost facts) | Contract tests vs the fake; redaction tests (synthetic key never in errors or logs); a live smoke `test:live` that runs only when `AGENT37_API_KEY` is set and is skipped in CI by default, list-only |
| 3 | **Schema: `kind: agent37` and broker connector** | JSON Schema, zod, CUE, `policy.ts`, `config.ts`, offers, broker kind, fixtures; `.hobo/ci.json` gets a **disabled** example entry | Schema-parity tests (three models agree on fixtures), invalid fixtures (non-`us` + `default`, oversize shape, >100 allow entries) |
| 4 | **Capture spec + link field + remove secret form mode** | Section 7 rows 1–3. Lands after #2598 or is rebased onto it **by a forward merge, never a rebase of pushed commits** | Existing capture leak-watch suite extended with `AGENT37_API_KEY`; channel-selection tests (a remote host without URL mode is refused); pact update for the capture MCP App |
| 5 | **`hobo ci connect agent37` and auth chain** | `provider-auth-chain.ts`, the pool form (6.3a), URL capture (6.3b), verify, webhook registration with direct-to-store secret | MCP eval with a fake host (form + URL capabilities, URL-only, none); asserts no secret in tool results; Connection record `api-key/active` |
| 6 | **Agent37SandboxDriver + controller wiring** | Driver (5.2), composition in `packages/ci-vercel/src/sandbox-composition.ts` and `hobo ci serve`; webhook endpoint with Standard Webhooks verification | Reuse `sandbox-controller.test.ts` scenarios with the Agent37 driver against the fake: lost create, lost JIT response, double start, 402/409/503, orphan reaping, budget refusal, fallback `unmet` |
| 7 | **Prebaked runner template (optional)** | A Dockerfile FROM `agent37-ubuntu`-compatible base with the pinned runner and toolchain, published as a workspace template by the owner (needs a funded wallet, so Tyler's call) | Image-content test (runner SHA pinned) |
| 8 | **Route-runner capacity source** | `agent37Capacity()` feeding the routing lane's verifier; `externalPools` entry; ordering `fleet → agent37 → github`; non-required jobs first | Route-runner unit tests: healthy, unhealthy, over-budget, and merge-group cases |
| — | **Owner-box fleet demand (ops)** | `scripts/ci/agent37-fleet-demand.mts` + `contrib/orchestrator-only/agent37-runner-controller-demand.sh` merged into `bin/agent37-runner-controller.sh`: count `agent37` queue depth, merge-group floor of four boxes for four script shards, `RESERVED_RUNNER_SLOTS_PER_BOX=1` so council dispatchers on shared VMs do not consume the last runner slot | `scripts/test/agent37-fleet-demand.test.ts`; finding 172 |
| 9 | **Live enablement (Tyler-gated)** | Flip `enabled: true` for non-required workflows only, after Tyler creates a CI-only workspace, funds it, and captures the key. Measure create+prepare p50/p95 and per-job cost; required-gate eligibility per 5.4 | Fleet sign-off evidence (`scripts/ci/fleet-signoff.mts`) |

Process rules for every PR: signed commits (`git commit -s`), no force-push or rebase of pushed branches, no `--no-verify`, Z.ai full-diff review plus green CI before merge-async enqueue, no Cursor-written fixes.

## 9. Rules carried into this design
- **HoBo deployments are never Git-linked** (Vercel or anywhere). The relay that hosts the controller is deployed only through HoBo CD. Agent37 templates are built and pushed by explicit commands, never by a Git integration.
- **No paid tools, no paying for infrastructure** without Tyler. Everything through PR 8 runs against the fake. Real Agent37 use (PR 7's cloud build, PR 9) waits until Tyler funds a workspace himself. HoBo never calls `POST /v1/signup` or `POST /v1/billing/top-up`.
- Credentials live only in the secret store. Test secrets are synthetic, generated at runtime, and never written to disk.
- Adding Agent37's docs MCP server to Tyler's account would need his confirmation; it isn't required for this work.

## 10. Open questions (undocumented in Agent37 docs)
1. API key expiry, and whether scoped or read-only keys are planned. (Undocumented: keys look full-workspace and unlimited.)
2. OAuth or OIDC/workload identity for the Sandbox API. (None documented.)
3. Typical create latency for `default` and `vm`.
4. General Sandbox API rate limits.
5. Whether exec request bodies are retained or logged. This affects JIT push vs pull.
6. `GET /v1/instances` pagination and filtering at scale.
7. Whether the $5 starter credit counts as "funded" for `vm` creates and template builds.
(Resolved: `network.allow` supports a leading `*.` wildcard, HTTPS/443 only, per the instance-network page.)

These can be asked through Agent37's feedback endpoint or by email (vishnu@agent37.com), but **only with Tyler's OK**, since that's an external message.
