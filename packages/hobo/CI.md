# CI from the HoBo CLI

The composed `hobo` binary exposes the CI relay and existing GitHub Actions
workflows. Run `hobo ci` or `hobo ci --help` for help. No Bindle, Station setup,
SDK script, or workspace package invocation is needed.
CI commands work before local Yard provisioning and do not initialize its journal.

## Connect once

Your relay operator supplies an HTTPS origin and a CI account credential. Export
`HOBO_CI_ACCOUNT_TOKEN`, or set `HOBO_CI_ACCOUNT_TOKEN_FILE` to a mounted credential
file. Tokens are never accepted as CI command-line values or stored in the link.
Human `hobo login` credentials do not authorize the CI account API.

```sh
hobo ci connect --relay https://ci.example.com
```

To create or install the GitHub App as part of setup, use an interactive terminal:

```sh
hobo ci connect github --relay https://ci.example.com
```

The relay must support its hosted App bootstrap and account-onboarding endpoints;
the operator must provision the relay, its vault, and the account credential first.
If the App is not ready, the CLI opens the relay's registration page. Its manifest
prefills the name, webhook, events and CI permissions. The App owner approves
registration in GitHub; the relay exchanges the one-use code and stores the App
private key, webhook secret and OAuth client secret encrypted in its vault. Those
secrets do not pass through the CLI or its output. Operator bootstrap credentials
are entered in the relay page when required.

GitHub's [manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#github-app-manifest-parameters)
do not include Device Flow. If it is disabled, the CLI opens GitHub's App settings;
the App owner must enable **Device Flow** and save. The CLI verifies the setting
using GitHub's device authorization, observes the prescribed polling interval,
and discards the resulting short-lived user credentials. It then opens the relay's
GitHub authorization and installation page and waits for an installation bound to
the CI account. For an existing installation, select its repository access in that
page and press Enter when finished. Repository setup still verifies the selected
installation and asks for isolated-runner consent. Registration and installation
timeouts are not proof of failure: inspect the relay and GitHub before retrying an
uncertain App creation.

The CLI does not create or distribute a fleet membership. Joined devices or
clusters must have a configured runner provider and relay access. Installing the
App and connecting a repository does not prove that any runner is available or
that a GitHub Actions job has executed.

Prefer the committed **`.hobo/ci.json`** profile when present. It names each
environment's `relayOrigin`, optional `jobAdmission` (`push` for hosted relays,
`pull` for loopback laptops), and `selection` rules for branch/CD routing. Local
overrides belong in gitignored **`.hobo/ci.local.json`** or `HOBO_CI_ENVIRONMENT`.
`hobo ci enable` reads that file before `--relay` / `HOBO_CI_RELAY_URL`.

## Host a local relay

`hobo ci serve` runs the same relay as the hosted one: the same core, account
API and HTTP routes, over a local SQLite file. It adds the listener, a
5-second worker tick and, with pull admission, the same GitHub job poller the
box worker runs. It does not have the GitHub App bootstrap and OAuth
onboarding or the delivery repair, which are Postgres-only today. See [one
relay, thin hosts](../ci-gh-actions/README.md#one-relay-thin-hosts).

When the `local` environment (or any profile with loopback `relayOrigin` and
`jobAdmission: "pull"`) should admit jobs without a public webhook URL, run the
relay on your machine:

```sh
HOBO_CI_ENVIRONMENT=local hobo ci serve --installation-id <app-installation-id>
```

Defaults come from the resolved **`.hobo/ci.json`** environment: `relayOrigin`,
`jobAdmission`, and `allowInsecureLoopback`. Flags override config. The command
binds **127.0.0.1** by default; non-loopback binds require an explicit public
**`--origin`** (HTTPS, matching `relayOrigin`) or **`--allow-insecure`**. Use
**`--host 0.0.0.0`** and **`--port`** for containers; keep **`--origin`** on the
public URL when a reverse proxy terminates TLS (**`--trust-proxy`** honors
`X-Forwarded-Proto`). GitHub App credentials load from `HOBO_CI_GITHUB_APP_*` /
`*_FILE` env vars (never printed). Optional **`HOBO_CI_INGRESS_FORWARD_SECRET`**
verifies ingress-forwarded webhooks. **`--print-config`** shows the resolved
plan with secrets redacted. **`--with-worker`** starts the isolated-container
sidecar with its own lease journal: local SQLite at
`<HOBO_HOME>/ci/serve/worker.sqlite` (override `HOBO_CI_WORKER_DB`) that polls
GitHub for `runs-on: hobo` jobs, unless the environment's
`"store": { "kind": "postgres", "urlEnv": "<ENV_NAME>" }` points it at a shared
relay partition (the config holds the env var name, never the URL). Graceful
shutdown on SIGINT/SIGTERM.
The `postgres` store kind is superseded by [ADR-0179](../../docs/design/adr/hosted-relay-stateless.md#adr-0179) (the hosted relay keeps no database) and is removed in phase 7 of its [delivery plan](../../docs/design/hosted-relay-stateless.md#delivery-plan).

When `.hobo/ci.json` has an `agent` block, `hobo ci serve` also starts the
[CI agent](../ci-agent/README.md) beside the relay: it plans the merge queue
and resolves merge conflicts with the configured model, in the mode the block
sets (`observe` writes nothing to GitHub). The agent keeps its journal and
clones under `<HOBO_HOME>/ci/serve/agent`, and reads each model credential
from this process's environment by the name the block references; a name that
is not set stops the serve. **`--no-agent`** serves without it. The agent is a
separate package, `@hobo/ci-agent`, loaded only when a block is present; a
`hobo` install without it refuses to serve such a project unless `--no-agent`
is passed.

Alternatively, import a self-hosted App's key and webhook secret from files:

```sh
hobo ci github import-key --app-id 12345 \
  --key-file /private/path/app.pem \
  --webhook-secret-file /private/path/webhook-secret
hobo ci github key-status
```

The CLI verifies the RSA key against GitHub's App identity before changing the
active version. It stores files with owner-only permissions under
`HOBO_HOME/ci/github-credentials/`, refuses a HoBo home inside a Git
checkout, and never prints the key or secret. File import currently requires
POSIX permissions; on Windows use the relay's mounted secret files instead.
`hobo ci serve` and its
`--with-worker` process use this version when no explicit App credential
environment is set; explicit environment credentials take precedence as a unit.
Incomplete or unreadable App credentials fail startup rather than falling back
to the local fixture App.
With real App credentials, `ci serve` also requires `HOBO_CI_ACCOUNT_TOKEN`,
`HOBO_CI_ACCOUNT_TOKEN_FILE`, or `HOBO_CI_CONTROL_TOKENS_FILE`. When it generates
the local control-token configuration, it grants the explicitly selected
`--installation-id` to the local account and stores only the token's hash. A
supplied control-token file remains authoritative.
The source files must already exist in a private location. A `--home` outside the
checkout is still accessible to processes with that user's filesystem access;
choose the host and access controls accordingly.

To rotate a self-hosted private key, generate another key in GitHub App settings,
repeat the import with the new file and the existing webhook secret, restart all
relay and worker processes, and only then revoke the old key in GitHub. Older
local versions remain under `HOBO_HOME/ci/github-credentials/versions/` until an
operator removes them after the restart. Keep the webhook secret in the same
secret manager as the relay; if it is reset in GitHub, update the relay together
with GitHub's setting. This file import does not replace credentials in the hosted
encrypted vault; hosted vault rotation and automatic distribution to joined devices
or clusters are not implemented.

Remote relay deployment: [`../ci-gh-actions/REMOTE-RELAY-SERVE.md`](../ci-gh-actions/REMOTE-RELAY-SERVE.md).

```sh
hobo ci serve --environment production --host 0.0.0.0 --port 8787 \
  --origin https://ci.example.com --trust-proxy
hobo ci serve --environment local --port 8787 --admission pull --installation-id 12345
hobo ci serve --print-config --environment local
```

See [`../ci/RUNNER-QUEUE.md`](../ci/RUNNER-QUEUE.md) for NAT/pull admission setup.

`enable` and `connect` run the same setup. The CLI detects the sole Git remote,
prompts when several exist, and asks before enabling isolated runners. Subsequent
commands reuse a unique remote matching the saved repository. Use
`--remote origin` to choose explicitly, or `--repo owner/name` outside a checkout.
If the App is not installed, the command prints the relay's GitHub installation
page; install it and repeat the command. Multiple bound installations require
`--installation-id`. The relay verifies repository ownership and permissions.
An existing connection is verified against GitHub again and reported as unchanged
without rewriting its settings or policy revision. If you explicitly select a
different installation for an existing connection, setup refuses the mismatch;
the relay operator must drain and migrate that connection. `status --json`
includes the connection's installation ID.

The confirmation permits **every matching repository job**, including jobs from
fork pull requests, to use isolated runners within the account policy. For an
unattended setup, provide both confirmations explicitly:

```sh
hobo ci enable --relay https://ci.example.com --remote origin \
  --yes --accept-all-matching-jobs --non-interactive --json
```

The relay must support isolated repository connections and have eligible provider
capacity and an account policy. The CLI does not create provider accounts, grant
budgets, or refresh allocation/pricing evidence. See the
[relay onboarding guide](../ci-gh-actions/ONBOARDING.md).

After connecting, change the runner label on the desired GitHub Actions jobs:

```yaml
jobs:
  test:
    runs-on: hobo
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
```

Commit and push the workflow through your usual review process. Connecting does
not rewrite or commit workflow files. Setup does not prove a live job executed;
verify the first run and its runner attribution.

The credential-free link lives under `HOBO_HOME/ci/links/`, keyed by the checkout
root. The default home is outside the repository; an explicit `--home` or
`HOBO_HOME` inside the checkout stores the link there. It records only the origin,
account ID, and repository. Future setup/status calls reuse that origin for the same repository
and check account continuity. `--relay` and `--repo` explicitly reconnect a target.
`HOBO_CI_RELAY_URL` can select the relay instead. Each invocation reads and pins
its credential so token-file rotation cannot switch accounts halfway through
setup. The HTTP client rejects redirects and uses revision checks on writes.
If saving the local link fails after connecting, the CLI reports that separately;
repeating setup with the same explicit relay/repository reuses the connection.

## Inspect and retry runs

Run commands use the authenticated [GitHub CLI](https://cli.github.com/manual/gh_run)
(`gh`), with an explicit repository target. They can inspect existing Actions
runs before connecting a relay. They report GitHub run IDs, separate from relay
lease IDs; use `hobo ci status` to check the HoBo connection.

```sh
hobo ci list
hobo ci ls --all-branches --limit 20 --json
hobo ci inspect
hobo ci logs 123456789 --failed
hobo ci logs 123456789 --task test --grep error
hobo ci grep error --runs 10
hobo ci rerun 123456789
hobo ci status
```

`hobo ci status` reports the relay connection and, under it, the relay mesh's
nodes as a table: node, state (`live`, `unhealthy`, `lost`), free/total slots,
free memory and disk, reliability and trust (`trusted`, `unverified`,
`invalid`). `--json` carries the same list as `data.mesh`. A relay with no
mesh answers `mesh: "not-configured"`; a relay too old to have the route
leaves the connection status as the whole answer. With no relay to ask (none
selected, no credential, or no network), `status` shows the report this
machine's local runner keeps in `.hobo/ci-local/mesh-node.json`
(`HOBO_CI_LOCAL_STATE_DIRECTORY`), when there is one.

List defaults to the current branch. Inspect/logs default to the current commit.
Rerun without an ID selects a failed run for that commit; retrying a successful
run requires an explicit ID. `--wait` follows one pinned attempt for up to ten
minutes, tolerating short GitHub read outages without repeating the rerun.
If a concurrent rerun intervenes or the next attempt finishes before it can be
observed running, `rerun --wait` reports `HOBO_CI_RERUN_AMBIGUOUS` rather than
attributing that result to this request. Inspect the run history before retrying.
Ending the CLI or reaching that deadline does not cancel remote work. Inspect
the run before repeating a rerun if a request times out. Log reads share a 2 MiB
output budget; partial results identify unavailable logs and truncation. Human
output strips terminal controls from workflow titles and logs.
JSON output uses HoBo's envelope;
`--format json` and `-F json` are aliases of `--json`. Unsupported filters report
a usage error rather than silently changing their meaning.

## Vercel reference

Reference checked **2026-10-29** against the official
[CLI CI documentation](https://vercel.com/docs/cli/ci),
[CI setup guide](https://vercel.com/docs/ci), and upstream
[command definitions](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/ci/command.ts).

| Vercel CLI | HoBo CLI |
| --- | --- |
| `ci enable` | `ci enable`; `ci connect` is a HoBo convenience alias |
| `ci list` / `ls` | Same names; current-branch default, branch/commit/status/limit filters |
| `ci inspect [run]` | Same name and current-commit default; GitHub run IDs |
| `ci logs [run]` | Same name; failed/task/attempt/grep filters over Actions logs |
| `ci grep <text>` | Searches a bounded set of recent run logs |
| `ci rerun [run]` | Retries Actions runs; defaults to a failed run at the current commit |
| Sole remote detection / `--remote` | Initial selection matches; later calls reuse a uniquely matching saved remote |
| `--json` / `--format json` / `-F json` | HoBo JSON envelope |

Vercel does not currently ship `ci connect`. Vercel CI enables tagged Turbo tasks
on a repository linked to a Vercel project; HoBo uses existing Actions workflows
and `runs-on: hobo`. HoBo does not require Turbo or Vercel project linking.
Bare HoBo `ci` displays help successfully (Vercel returns usage exit 2).
GitHub's log records do not expose Vercel's structured log levels, invocation
pagination cursor, or single-task follow protocol; `--level`, `--next`, and
`--follow` are explicitly unsupported. Backend differences are kept visible.

## Contracts and checks

`test/ci-command.test.ts`, `test/ci-github-connect.test.ts`,
`test/ci-github-keys.test.ts`, `test/ci-serve.test.ts`, and `test/ci-runs.test.ts` cover setup, target selection,
unattended consent, account continuity for equivalent saved relay origins, run
selection and failure behavior. The CLI-to-relay consumer
contract pins method, account authentication, protobuf body and revision header;
the existing relay provider contracts protect isolated onboarding. The durable
link is generated from `data-models/composition.proto` with CUE constraints in
`composition.cue`. Run scoped TypeScript, schema/codegen drift, CLI consumer
contracts and documentation gates. These offline checks do not contact GitHub or
prove deployed relay/runner readiness.
The product unit harness isolates module state between files, gives claim tests
private credential homes, and uses version-probe stand-ins for Yard argument
tests so those checks neither touch a developer's credentials nor download tools.

`e2e/ci.test.ts` launches the built product binary against the production HTTPS
control plane and native PostgreSQL store. It covers consent and authentication
refusal, credential-free link persistence, restart recovery, idempotency and a
response lost after the connection commits. Only GitHub App identity calls are
emulated; this lane does not launch a provider runner. With Node 24, Git, OpenSSL
and a disposable local PostgreSQL instance:

```sh
pnpm exec turbo run build --filter=@hobo/hobo
HOBO_CI_TEST_POSTGRES=postgresql://user:password@127.0.0.1:5432/test \
  pnpm --filter @hobo/hobo test:ci-e2e
```

The test uses a unique partition and removes its records afterward. Its explicit
configuration keeps the service requirement out of ordinary unit tests. The
repository's existing manual, budgeted runner acceptance workflow remains the
live-provider check; general hosted Actions stay disabled by repository policy.

On **2026-10-29**, the built product binary submitted and waited for
[acceptance attempt 4](https://github.com/Tyler-R-Kendrick/HoBo/actions/runs/40569580252/attempts/4)
successfully. The workflow verified its HoBo self-hosted runner, checked-out SHA,
Node setup and artifact upload. `ci list`, `logs` and `grep` read that run through
the same binary. Its runner matched Vercel lease
`b1c3b545-ee2b-4bfd-be2c-1a47cb4d1257`; the native journal confirmed both sandbox
VMs stopped, runner deletion and measured cost settlement. Expired pricing
evidence was refreshed through `PostgresCiStore.reattestRate` after checking the
published rates, preserving the rate card, budgets, allowances and usage watermark.
This verifies the reviewed acceptance workflow and configured Vercel path;
other providers and arbitrary workflow dependencies require their own acceptance.

## Runner provider integrations (`hobo ci connect <provider>`)

`hobo ci connect` with no provider still sets up the HoBo relay (alias of `enable`); `hobo ci serve` still hosts the relay. With a provider, it records a third-party GitHub Actions runner integration in `.hobo/ci.json` under `integrations` and prints the provider's own sign-in step:

```sh
hobo ci connect blacksmith --org Hobo-Labs
hobo ci connect depot                                   # GitHub App runners
hobo ci connect depot --id depot-builds --auth oidc --project-id <project>
hobo ci connect jog                                     # alias: usejog
hobo ci connect boat --org Hobo-Labs --launch           # runs `boat ci connect`
```

| Provider | Auth (default first) | What the owner does | Labels |
|---|---|---|---|
| Blacksmith | `github-app` only. GitHub SSO; no API tokens or OIDC for runners | Install the Blacksmith GitHub App at app.blacksmith.sh (org owner; orgs only) | `blacksmith-<n>vcpu-ubuntu-<ver>` |
| Depot | `github-app` (runners), `oidc` (builds), `secret-ref` fallback (`DEPOT_TOKEN`) | Connect GitHub Actions in the Depot dashboard (org owner); for OIDC add a trust relationship and grant `id-token: write` | `depot-ubuntu-24.04` … |
| Jog (usejog) | `github-app` only; no tokens | Install the Jog GitHub App; private repos only; prepaid credits | `jog` |
| Boat | `device` (`boat ci connect` browser ceremony), `secret-ref` fallback (`BOAT_API_KEY`) | Complete `boat ci connect [--org]`; paid plan | `boat`, `boat-small`, `boat-large`, `boat-xlarge` |

Secrets never pass through HoBo:

- The config holds **references only**. `auth.secretRef` must be `github-secret:NAME` or `env:NAME`. The JSON schema, the CUE model (`#RunnerIntegration`) and the loader reject anything else, including credential-shaped or high-entropy strings in any field, and their errors never echo the value.
- The CLI never prompts for, reads or prints a credential. For `secret-ref` you store the value yourself (`gh secret set NAME` prompts).
- `--launch` runs the provider CLI with credential-like environment variables (`*TOKEN*`, `*SECRET*`, `*API_KEY*` …) removed, and output is redacted.
- `packages/hobo/test/ci-connect-leak.test.ts` generates synthetic, real-looking tokens at runtime (never written to disk) and asserts that none appear in CLI output, progress or the written config.

## Deploying the hosted relay with HoBo

`hobo ci deploy` deploys the hosted relay (`packages/ci-vercel`, declared as a
HoBo app in its `src/bindle.ts`) to Vercel from a git ref. Where it goes comes
from the relay's Yard, `packages/ci-vercel/deploy/yard.ts` (ADR-0179 phase 6):
the Yard names the provider, the project and repository, and the binding rows;
the target names a Camp (`production` or `preview`), and the rows that Camp
requires project the non-secret settings. Run it in the relay's project
directory or pass `--cwd packages/ci-vercel`:

```sh
hobo ci deploy --cwd packages/ci-vercel --ref main --team team_… --dry-run
```

`--dry-run` prints the placement, the chosen bindings and every request it
would send, and sends none. A real run reads `VERCEL_TOKEN` from the environment
and deploys to **preview** unless `--target production` is given. Production
chooses the config-service binding, which asks for the owner's two Infisical
ids:

```sh
hobo ci deploy --cwd packages/ci-vercel --ref main --sha <commit> \
  --target production --team team_… \
  --set INFISICAL_IDENTITY_ID=<hobo-ci-relay id> \
  --set INFISICAL_PROJECT_ID=<hobo-ci project id> \
  --provision --wait --dry-run
```

| Option | Means |
|---|---|
| `--repo`, `--project` | Override the Yard's `repository` and `project` (a fork, a scratch project) |
| `--set NAME=value` | A non-secret setting the Bindle's `config()` declares, or an input a chosen binding asks for. Never a setting the Yard already sets, never a secret, and never a storage integration's variable (`DATABASE_*`, `REDIS_*`, `KV_*`, `UPSTASH_*`, `TURSO_*`, `LIBSQL_*`, `BLOB_*`, `VALKEY_*`) or an `INFISICAL_*` name other than the five coordinates |
| `--provision` | Before deploying, attach the Marketplace bindings the Camp chooses (the Upstash cache), idempotently, with the Vercel CLI (`HOBO_VERCEL_CLI`, or `vercel` on the PATH). A failed attachment is reported in `provisioned` and the deploy goes ahead |
| `--wait` | Wait (up to 15 minutes) for the deployment to be READY; ERROR, CANCELED or a timeout fails with `HOBO_CI_DEPLOY_NOT_READY` |
| `--create-project` | Create the project when Vercel has none by that name, with the Yard's root directory |

Nobody runs this against production by hand: the
[relay deploy workflow](../../.github/workflows/relay-deploy.yml) runs it on
every merge to `main` that changes the relay, reading the Vercel token from the
config service with GitHub OIDC. See
[`CONFIG-SERVICE.md`](../ci-vercel/CONFIG-SERVICE.md#the-deploy-workflow-on-main)
for the repository variables it needs, and [the README](README.md) for the plan
record and its gates. It has been exercised against fakes only.


## Create the hosted relay's GitHub App

`hobo ci app create` creates the hosted relay's GitHub App with GitHub's
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
and stores its credentials straight in the relay's config service, Infisical
(ADR-0179, phase 3). Nothing is written to disk or printed.

```sh
export INFISICAL_PROJECT_ID=<project id> INFISICAL_ENVIRONMENT=prod \
  INFISICAL_SECRET_PATH=/hobo-ci-relay INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<id>
read -rs INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET && export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
hobo ci app create --relay https://<relay-host> --owner-id "$(gh api user --jq .id)"
```

1. It signs in to Infisical first, with Universal Auth credentials from the
   environment (`INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` and `_SECRET`, the names the
   Infisical CLI reads) or an access token in `INFISICAL_TOKEN`, and lists the
   folder's names. If App credentials are already there it stops unless `--yes`.
2. It serves a page on `127.0.0.1` and opens it (the URL is also printed). The
   page posts the manifest (`createGithubAppManifest`, the reviewed permissions
   and events, webhook `<relay>/github/webhooks`) to GitHub; GitHub sends the
   browser back to `http://127.0.0.1:<port>/callback` with a one-time code and
   the random `state`, which must match.
3. It converts the code (`POST /app-manifests/{code}/conversions`) and checks
   the App against the reviewed configuration and `--owner-id`
   (`verifyConvertedGithubApp`, which also proves the key with `GET /app`).
4. It writes `HOBO_CI_GITHUB_APP_PRIVATE_KEY`, `HOBO_CI_WEBHOOK_SECRET`,
   `HOBO_CI_GITHUB_APP_CLIENT_SECRET`, `HOBO_CI_GITHUB_APP_CLIENT_ID` and, last,
   `HOBO_CI_GITHUB_APP_ID` to the folder, and prints their `infisical://`
   references and the App's install link.

GitHub returns the credentials once: the conversion cannot be repeated. If a
write fails, the credentials stay in this process's memory only and the write
is retried: at a terminal, after you fix Infisical access and press Enter (or
type `discard`); without one, up to five times with backoff. If it cannot
succeed, the command says which entries were stored, discards the rest, and
tells you to delete the App (`https://github.com/settings/apps/<slug>/advanced`)
and run it again. The same applies when the converted App fails verification.

Owner setup (projects, identities, roles) is in
[the relay's config service](../ci-vercel/CONFIG-SERVICE.md). Tested with
local fakes of GitHub and Infisical only (`test/ci-app-create.test.ts`).
