# Status feed (L27)

`createStatusFeed({ store, now, log })` publishes the authority's two
availability objectives (design §6.14) to `@hobo/status-page`. They are
measured in production from the status page; before cutover only their
emission is checked (O20).

| Component (`record`) | `componentId` | Target |
|---|---|---|
| `enrollment-api`: one sample per enrollment API request, up unless it failed for the service's own reasons | `fleet-enrollment-api` | 0.999 |
| `nats-callout`: one sample per callout decision on a new NATS connection | `fleet-nats-callout` | 0.9995 |

- `tick()` appends one `slo.Measured` event (`SloMeasuredData`) per finished
  minute and component to the stream `slo-<componentId>`, with `attainment`
  = up samples / samples of that minute, `measuredAt` = the end of the
  minute, `sloName` `availability` and `scopeKey`
  `service:hobo-fleet-authority`, so the status page folds both into one row.
- A minute with no sample had no failed request: its attainment is 1. Every
  minute since the feed started is emitted exactly once, also when ticks are
  late, so `availability_expected` (two per minute) is countable.
- Replicas share the store: each event carries the idempotency key
  `<componentId>/<measuredAt>`, so the first replica's append wins and the
  others are deduplicated.
