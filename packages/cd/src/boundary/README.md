# `@hobo/cd/boundary` — CDEvents, CloudEvents webhooks, notifications

Owner: WP16 (plan 0024, C6, D17, R8). Export: `@hobo/cd/boundary`.

Status leaves HoBo CD as open standards, so no CI, observability vendor or
chat tool is required to follow a delivery.

## What is here

| File | Role |
|---|---|
| `STANDARDS.lock.json` | Pinned CDEvents release (**v0.5.1**, `specversion` `0.5.1`, event versions `0.3.0`), the CloudEvents binding and the webhook signature standard. `CDEVENTS_SPEC` in `cdevents.ts` must match it (golden test). |
| `cdevents.ts` | CDEvent shape, pinned type ids (`CDEVENT_TYPES`), custom type builder (`hoboEventType`), deterministic ids, purls, canonical JSON, and `assertCdEvent` — the structural check from the pinned JSON schemas that every event passes before it leaves. |
| `projection.ts` | `createCdEventsProjector` / `projectCdEvents`: a pure fold of the CD journal into CDEvents. |
| `relay.ts` | `createCdEventsRelay`: `readAll` → projector → sinks, with a caller-persisted delivery cursor. Read-only. |
| `webhook.ts` | `createCloudEventsWebhookSink`: CloudEvents HTTP binary mode, Standard Webhooks v1 HMAC signature, bounded retry with backoff, dead-letter. `verifyWebhookSignature` for receivers. |
| `notification.ts` | `createNotificationPort`: the frozen `NotificationPort` as `dev.cdeventsx.hobo-notification.sent.0.1.0` events over per-channel webhook sinks. |
| `errors.ts` | `BOUNDARY_FAILURES`: typed failure codes with remediation. |
| `json.ts` | Tag-based JSON guards and the JSON clone used at the journal-body boundary. |

## Projection

| Journal fact (body) | CDEvent |
|---|---|
| `freight.Recorded` (`FreightRecord`, Bindle subject) | `artifact.published` per artifact; subject id = the artifact's purl (`coordinate` if it is a purl, else `pkg:oci/…` / `pkg:generic/…@<digest>`). |
| `freight.Recorded` (Rail subject) | `dev.cdeventsx.hobo-rail.recorded.0.1.0` |
| first `set.Created` for a Camp (`SetRecord`) / `env.Cloned` | `environment.created` (`name` = Set environment or Camp id) |
| `set.Created` with origin `CONFIG` or `TOPOLOGY` | `environment.modified` |
| `env.Promoted` (`PromotionRecord`), per target Camp | `service.deployed` (first Freight of that Bindle on the Camp) else `service.upgraded`; subject id = Bindle, `environment.id` = Camp id, `artifactId` = purl of the Freight's first artifact. |
| `env.PromoteRolledBack`, per target Camp | `service.rolledback` with the previously deployed Freight's artifact, or `service.removed` when nothing earlier is known. |
| `deployment.Converged` of a `TEARDOWN`/`DEPARTURE` Set | `service.removed` for every Bindle on the Camp |
| `env.Expired`, `camp.Departed` | `environment.deleted` |
| `env.Promoted` of a Rail | `dev.cdeventsx.hobo-rail.promoted.0.1.0` |
| `freight.Yanked/Qualified/Approved/Retired`, `env.PromoteRejected/Superseded`, `verification.Completed`, `deployment.ReconcileBlocked`, `fanout.Halted/Completed/RolledBack`, `failover.Completed/Refused`, `compliance.Changed`, `policy.BindingChanged` | `dev.cdeventsx.hobo-<subject>.<predicate>.0.1.0`; content = the secret-free record (protobuf JSON). |

- Context: `specversion` from the lock, `source` from configuration
  (e.g. `/hobo/cd/<tenant>`), `timestamp` = recorded event time, `chainId` =
  the journal correlation id when present.
- `id` is a UUID-shaped sha256 of (source event id, type, discriminator), so
  replay is byte-identical (I8) and receivers can de-duplicate at-least-once
  delivery.
- HoBo context goes in `customData` (`freightId`, `promotionId`, …) with
  `customDataContentType: application/json`; standard `content` carries only
  what the schema allows (`additionalProperties: false`).
- Bodies are parsed with the generated protobuf schemas; a body that does not
  parse is skipped and counted (`hobo.cd.boundary.cdevents.skipped`), never
  trusted.
- Custom events follow the spec's `dev.cdeventsx.<tool>-<subject>.<predicate>`
  form with tool `hobo` (plan wording: `dev.cdeventsx.hobo.*`).

## Architecture

- **Parse, don't validate.** Journal bodies are parsed into the generated
  protobuf records (`fromJson` with the `@hobo/cd` schemas); only those parsed
  derived types reach the projector, and a body that does not parse is
  skipped. Every outgoing event is a `CdEvent` that has passed
  `assertCdEvent`, so an event the pinned schema would refuse cannot be
  constructed past the projector.
- **Events, projection, event store.** The boundary issues no command and
  appends no event. `createCdEventsRelay` is a materialized-view consumer of
  the event store (`DurableEventStore.readAll`); the projector is its fold
  (a projection), and its in-memory state is the snapshot rebuilt on start by
  replaying from the beginning. The delivery cursor (`deliveredThrough`) is
  the read store checkpoint the host persists, so a restart neither re-sends
  nor loses events. One relay per tenant is the single actor delivering for
  that journal; at-least-once delivery is safe because ids are deterministic.
- **Command families it reacts to** are the journal facts in the projection
  table; the read store for undeliverable events is the `DeadLetterSink`.

## Webhook delivery

- `POST <endpoint>`; https only (`allowInsecureHttp` admits loopback http).
- Headers: `content-type: application/json`, `ce-specversion: 1.0`, `ce-id`,
  `ce-source`, `ce-type`, `ce-subject`, `ce-time` (CDEvents CloudEvents
  binding, binary mode); body = the canonical CDEvent JSON.
- Signature (Standard Webhooks v1): `webhook-id` (= CDEvent id),
  `webhook-timestamp` (seconds), `webhook-signature: v1,<base64
  HMAC-SHA256("<id>.<timestamp>.<body>")>`. Secrets prefixed `whsec_` are
  base64-decoded. The secret is resolved per delivery through
  `CredentialResolver.resolve(secretRef, "cd.webhook.sign")` and never stored;
  no secret, no send.
- Retries: 408, 425, 429, 5xx and transport errors; backoff 1 s · 2ⁿ⁻¹
  capped at 5 min, `Retry-After` honoured within the cap, no jitter; at most
  `CD_DEFAULTS.webhookMaxAttempts` (8) attempts — a caller cannot raise it.
  Other 4xx dead-letter at once.
- Dead-letter: a `DeadLetterSink` (`createMemoryDeadLetter` for local runs;
  the host persists entries). Entries carry the event, endpoint, attempts,
  status and code, so they can be replayed.

## Metrics (through `TelemetrySink`, advisory)

| Metric | Kind | Attributes |
|---|---|---|
| `hobo.cd.boundary.webhook.deliveries` | counter | `cdevents.type`, `outcome` |
| `hobo.cd.boundary.webhook.attempts` | histogram | `cdevents.type`, `outcome` |
| `hobo.cd.boundary.webhook.dead_letters` | counter | `cdevents.type`, `code` |
| `hobo.cd.boundary.cdevents.projected` | counter | `cdevents.type` |
| `hobo.cd.boundary.cdevents.skipped` | gauge | — |

## Proof

- Golden: `test/boundary/golden/cdevents.v0.5.1.jsonl` pins the projection of
  `test/boundary/journal.ts` byte for byte; regenerate with
  `node --import tsx test/boundary/write-golden.ts` and review the diff.
- PACT: `test/boundary/cdevents-webhook.pact.json` (consumer `HoboCdBoundary`,
  provider `CloudEventsWebhookReceiver`): accepted, rejected signature,
  overloaded then accepted.
- I11: `test/boundary/neutral-core.test.ts` scans every `@hobo/cd` source
  outside `adapters/` and `verification/sources/` for forbidden imports and
  vendor-named types.

## Runbook

| Symptom | Code | Action |
|---|---|---|
| Sink refuses to start | `webhook-endpoint-invalid` | Use an absolute https URL with no userinfo or fragment. |
| Every delivery throws before sending | `webhook-secret-missing` | Store `{ secret }` under the configured `secretRef`; HoBo never sends unsigned. |
| `hobo.cd.boundary.webhook.dead_letters{code=webhook-rejected}` rises | `webhook-rejected` | The receiver answers 4xx: check its secret and signature verification (it must verify `id.timestamp.body` exactly as sent), then replay the dead letters. |
| `…{code=webhook-retries-exhausted}` rises | `webhook-retries-exhausted` | Receiver down or overloaded for ~2 min of backoff. Fix the receiver, then replay. |
| Receiver reports `webhook-timestamp-stale` | — | Clock skew > 5 min between sender and receiver; fix NTP. |
| `notify` throws | `notification-channel-unknown` | Add the channel to `createNotificationPort({ channels })` or correct the hook's channel name. |
| `hobo.cd.boundary.cdevents.skipped` grows | — | A journal body does not parse against the generated schema: an upcaster is missing upstream. The event was not sent. |
| A projector throws | `cdevent-invalid` | Bug: an event failed the pinned schema check. Report the source event id; nothing was sent. |
| Upgrading the CDEvents spec | — | Bump `STANDARDS.lock.json` and `CDEVENTS_SPEC`/`CDEVENT_TYPES` together, update `assertCdEvent` rules from the new schemas, regenerate the golden file. |
