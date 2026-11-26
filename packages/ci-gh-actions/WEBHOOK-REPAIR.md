# GitHub webhook delivery repair

The hosted relay's repair tick runs `src/webhook-repair.ts` with GitHub App JWT
credentials and its claims on the cache (`CacheWebhookRepairClaims`). It scans
up to five delivery-history pages per invocation and keeps its cursor in the
cache. A lock per App (five-minute TTL, renewed at each checkpoint) prevents
concurrent scans for the same App.
Per-GUID claims have a 15-minute cooldown and an App-wide limit of 20 claims per
minute. A failed request
keeps its claim and is retried after the cooldown. A delivery the relay already took in or
a successful GitHub delivery on an earlier page is skipped, including a signed
delivery that was deliberately ignored by the relay.

GitHub states that redelivery uses the original `X-GitHub-Delivery` GUID and
that its delivery logs and redelivery are available for three days. The repair
worker keeps success GUIDs for four days and handles all failed `workflow_job`
and `workflow_run` deliveries still returned by GitHub after a one-minute grace
period. If an outage lasts beyond GitHub's retention period, a missed delivery
may no longer be redeliverable; recovering such jobs also requires a separate
queued-job reconciliation strategy. An already admitted delivery remains
idempotent even if a later scan encounters its original failure.

Tests simulate GitHub's HTTP boundary and verify pagination, resumption,
deduplication and authentication; the cache claims' tests verify cursor
persistence, single-scanner fencing and rate limiting on the in-memory cache.
They do not verify a live GitHub App or a deployed relay.
