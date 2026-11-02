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

Prefer the committed **`.hobo/ci.json`** profile when present. It names each
environment's `relayOrigin`, optional `jobAdmission` (`push` for hosted relays,
`pull` for loopback laptops), and `selection` rules for branch/CD routing. Local
overrides belong in gitignored **`.hobo/ci.local.json`** or `HOBO_CI_ENVIRONMENT`.
`hobo ci enable` reads that file before `--relay` / `HOBO_CI_RELAY_URL`.

## Host a local relay

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
sidecar when `DATABASE_URL` matches the relay store. Graceful shutdown on
SIGINT/SIGTERM.

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

`test/ci-command.test.ts`, `test/ci-serve.test.ts`, and `test/ci-runs.test.ts` cover setup, target selection,
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
