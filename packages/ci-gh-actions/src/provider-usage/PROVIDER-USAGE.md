# Provider usage sync

A runner order's spend limit (`depot<=200usd`) reads what an account spent on
a hosted provider this month through a `SpendReader` (ADR-0183,
[runner order](../../../../docs/design/adr/runner-order.md)). The ledger
answers from settled leases and list prices (`LedgerSpendReader` in
`@hobo/ci`). For Depot, Namespace and WarpBuild this module reads the
provider's own usage API instead, once an hour, and puts that figure ahead of
the ledger's.

## What is read

Each reader makes one read call per sync and turns the answer into US
dollars for the month so far. Every page was read on 2026-11-17.

| Provider | Call | Field read | Dollars | Source |
| --- | --- | --- | --- | --- |
| Depot | `POST https://api.depot.dev/depot.core.v1.GithubActionsService/GetGithubActionsUsageProjection` (Connect JSON, `Connect-Protocol-Version: 1`) with `timeRange.startAt` and `endAt` | `actualCost` in the minor unit of `currency` | Cents divided by 100; a cost in any currency but USD is unmeasured | [GitHub Actions API](https://depot.dev/docs/api/github-actions-api), its [OpenAPI description](https://depot.dev/openapi/depot-github-actions/v1.json) |
| Namespace | `POST https://{region}.compute.namespaceapis.com/namespace.cloud.compute.v1beta.UsageService/GetUsage` with `periodStart` and `periodEnd` as calendar days | `total.instanceMinutes.unit` | Unit minutes times $0.0015, the rate for unit minutes above a plan | [Report on usage](https://namespace.so/docs/reference/typescript-sdk/compute/usage), [Public API](https://namespace.so/docs/reference/api), [Billing and included amounts](https://namespace.so/docs/workspaces/billing-and-limits) |
| WarpBuild | `GET https://api.warpbuild.com/api/v1/reports/billing/ci?start_date=…&end_date=…&per_page=1` | `summary.total_cost` | As given | [GET /reports/billing/ci](https://warpbuild.com/docs/api/reports/GetCIBilling), [API reference](https://warpbuild.com/docs/api) |

Each figure has a known limit:

- Depot's page says the cost "uses the published list rate and excludes
  discounts, credits, and custom pricing".
- Namespace answers unit minutes, not money. Minutes a prepaid plan includes
  cost less than the rate used here, and the total counts every instance of
  the workspace, not only CI runners. Both make the reading high, which only
  makes the limit pass over Namespace sooner.
- WarpBuild marks every endpoint alpha. A reply that no longer parses is
  unmeasured, and the ledger answers.

## Credentials

A subscription (`parseProviderUsageSubscription`) names an account, a
provider, Namespace's region where it applies, and a credential reference:
`env:NAME`, or `github-secret:NAME` in the form runner integrations use. A
value that looks like a token is refused with a sentence that does not repeat
it. `envCredentialResolver` resolves `env:NAME` from the relay's environment
for each sync; a `github-secret:` reference lives in a repository's Actions
secrets, which a relay cannot read, so that provider stays on the ledger.
Tokens are never stored: a reading holds an account, a provider, a month,
dollars, the time it was read and the source page.

Use the narrowest token each vendor offers. Every call above reads; none
changes anything at the vendor.

## The sync and the spend reader

`ProviderUsageSync.syncOnce()` reads every subscription. A missing token, a
refusal, a reply in another shape or a thrown error drops that provider's
reading at once. `scheduleProviderUsageSync` runs it at start and then every
hour (`PROVIDER_USAGE_SYNC_INTERVAL_MS`), one sync at a time.

`SyncedSpendReader` is the `SpendReader` the walk reads. It asks the fallback
(the ledger) first, then replaces each provider that has a reading for the
asked month no older than `PROVIDER_USAGE_MAX_AGE_MS` (three hours). It reads
memory only, so a routing step never waits on a vendor, and a failing ledger
still leaves the vendor figures.

## Contracts

`contracts/depot-usage.pact.json`, `namespace-usage.pact.json` and
`warpbuild-usage.pact.json` are hand-authored consumer expectations, one per
provider, each with a reading and a refused token. They are not captured
traffic and no vendor has verified them.
`contracts/provider-usage.consumer.test.ts` drives each reader through a fake
that answers only what its pact declares (`test/support/provider-usage-pact.ts`)
and checks that every interaction ran. Gauntlet case P02 syncs all three
through the same fake.

## Not proven

No reader has called a vendor. The readings, and the sync feeding the relay's
spend limit, are built, not proven until a relay with real read-only tokens
records one. The relay does not construct a `SyncedSpendReader` yet; wiring it
in front of `LedgerSpendReader` where the relay builds its route facts is the
remaining step.
