# Connected relay and runner acceptance

Run from the monorepo root after building `@hobo/ci` and installing the pinned
act v0.2.89 with the package's `act:install` script:

```sh
node --import tsx packages/ci-gh-actions/scripts/acceptance.ts --act /tmp/hobo-ci-tools/act --evidence /tmp/hobo-ci-acceptance
```

This lane runs the shipped `createRelayService`, its HTTP readiness endpoint,
automatic outbox/reconciliation worker, signed webhook intake, durable
SQLite reservations, provider dispatch, RS256 OIDC verifier against a locally
served JWKS, JIT registration, shipped `runHostProcess`, and actual act execution.
A strict local GitHub/provider boundary supplies the remote account API. It never
uses live credentials or treats mocked dispatch alone as executed work. New jobs
are dispatched by the service background tick; the harness does not manually
call `dispatchPending` or `reconcile`.

Each queued job owns one provider host and one JIT configuration. The launcher
validates that configuration against the dispatch's lease, provider, local host
execution ID, original job ID, runner name and workflow digest before starting
act. The unchanged `workflow.yml` contains exactly one `runs-on: hobo` job; its
shell step emits those same identities into a unique completion marker. The
harness refuses missing JIT, a mismatched host label, a skipped original job or
an unexpected marker. It does not run a separate multi-job graph under one lease.

Seven actual executions share one relay and durable ledger. Two free minutes on
each of WarpBuild, Depot, Kubernetes, Blacksmith and GitHub are consumed first.
The sixth execution bills the cheapest provider (WarpBuild); its provider budget
then forces Depot for the seventh. The exhausted account refuses the eighth
job with no dispatch or launch. Completion is signed, host shutdown and runner
cleanup are checked. The service drains accepted HTTP/worker activity and closes
its own database, then a new service reopens it through startup recovery. All
seven signed completions are replayed over the restarted HTTP service while its
worker revisits pending budget-denied demand. Two clean service drains and no
duplicate dispatch or billing are required. Meter timestamps and provider accounts are local
fixtures; actual vendor free allowances and invoices are not inferred.

The evidence directory retains the workflow copy, per-job identity markers,
relay database, `service-events.json` and `report.json` (including worker, restart
and drain counts). All seven jobs use native act execution on the
local machine. Provider routing and execution linkage are proved; compatibility
of nested runners on vendor-hosted machines and live GitHub queue consumption
require live acceptance.

The exported `runAcceptance({ actBinary, evidenceDirectory, fault })` supports
negative controls `missing-jit`, `wrong-provider` and `skip-job`; each must reject,
never pass as skipped. Unit evidence gates run in `test/acceptance.test.ts`.

## Live repository readiness

A read-only permission probe uses the current `gh` authentication and fails on
an inaccessible repository identity or Actions runners API:

```sh
node --import tsx packages/ci-gh-actions/scripts/acceptance.ts --live-verify --repository Hobo-Labs/HoBo
```

Success is only a permission probe, not a live workflow pass. A 403 is a failed
probe. The local lane does not repair permissions or conceal this result.

For the first JIT-only check, the reviewed manual acceptance workflow supports
`jit_only=true`. It avoids checkout, external actions and artifacts so it can
establish runner registration and a shell step before testing larger transfers.
After the App installation is bound, provision a current Sandbox offer and
account policy, enable the isolated host, and connect the repository with the
universal shared-label acknowledgment described in [onboarding](../ONBOARDING.md).
Dispatch the reviewed branch with:

```sh
gh workflow run hobo-ci-acceptance.yml --ref "$REVIEWED_BRANCH" -f jit_only=true
```

Correlate the GitHub run and runner name with the relay lease, then verify both
Sandbox sessions stopped and usage was settled. A passing shell step alone does
not prove provider selection, cleanup or billing, and this mode does not test
checkout or artifacts. The default dispatch runs the full acceptance recipe.

For live execution, install the relay and trusted host workflow first, then use
the existing `.github/workflows/hobo-ci-acceptance.yml` in this repository. Its
reviewed source is `../templates/hobo-ci-smoke.yml`; keep those bytes unchanged.
The local `acceptance/workflow.yml` belongs only to act and must not replace that
manual GitHub recipe. After GitHub discovers the manual workflow on the default
branch, it can be dispatched for the selected branch.

The manual recipe checks the actual self-hosted `hobo-<lease UUID>` runner,
repository, ref and checked-out SHA, then uploads that evidence. Verify that the
original GitHub job completed on that runner and correlate its lease, provider
host completion, cleanup and settlement in the relay; a successful provider host
workflow alone does not establish original-job completion.
