# `@hobo/cd/feed` — the delivery feed (WP11: C10, D5, I3, I4, I24)

`createDeliveryFeedHandler` implements the frozen `DeliveryFeedHandler`
(`pathPrefix: "/v1/cd/"`). It is the Station side of agent-mode pull
reconciliation, mounted by the CD service host (WP12) and served by `hobo
serve cd`. Agents dial in over outbound HTTPS (`../agent`); the Station never
opens a connection to an agent and never holds a target credential (I3).

## Routes

| Method | Path | Auth | Body / query | Success | Notable refusals |
|---|---|---|---|---|---|
| POST | `/v1/cd/enrollments` | bootstrap token in body | `{token, publicJwk, claims}` | 201 `{reconciler, state}` | `token-*`, `jwk-invalid`, `key-revoked` |
| POST | `/v1/cd/svid/refresh` | DPoP (activate) or SVID + DPoP (refresh) | `{reconcilerId}` / `{}` | 200 `{svid, expiresAtMs}` | `enrollment-incomplete`, `svid-expired`, `dpop-*` |
| POST | `/v1/cd/leases` | SVID + DPoP | `{campId, holderId, ttlMs}` | 201 lease | `lease-held`, `camp-not-accepted` |
| POST | `/v1/cd/leases/renew` | SVID + DPoP | `{lease, ttlMs?}` | 200 lease | `stale-fence`, `lease-mismatch` |
| POST | `/v1/cd/leases/release` | SVID + DPoP | `{lease}` | 200 | — |
| GET | `/v1/cd/feed` | SVID + DPoP | `?camp&holder&fence[&redeliver=1]`, `Last-Event-ID` | 200 `text/event-stream` | `camp-not-accepted` |
| GET | `/v1/cd/blobs/{digest}` | SVID + DPoP | `?camp` | 200 `application/vnd.hobo.resolved-set+json` | `blob-missing`, `blob-corrupt`, `blob-not-referenced` |
| POST | `/v1/cd/observations` | SVID + DPoP | `{lease, observation}` | 201 `{position}` | `stale-fence`, `observation-invalid`, `attribute-*` |
| POST | `/v1/cd/checkpoints` | SVID + DPoP | `{lease, position}` | 200 `{position}` | `stale-fence`, `checkpoint-regression` |

JSON responses are envelopes: `{ok: true, value}` or `{ok: false, reasons:
[ReasonRecord]}` with a status from `FEED_FAILURES` / `AGENT_FAILURES`. Leases
carry `fence` and positions as decimal strings (64-bit safe). The contract is
`contracts/feed.pact.json`.

## SSE

- `id: <position>` / `event: frame` / `data: <DeliveryFeedFrame JSON>`; a
  heartbeat comment every 15 s; `event: end` with `reason` `caught-up`,
  `long-poll` (55 s with nothing new) or `limit` (back-pressure: 64 frames per
  response). A response without `end` was cut off: the agent resumes with
  `Last-Event-ID`, so nothing is skipped or repeated.
- Frames start after the Camp's committed checkpoint (or `Last-Event-ID`).
  The first feed of a lease (`redeliver=1`) re-delivers the current change
  when nothing newer exists, so a restarted agent re-observes the target.
- The resolved set is inline when its blob is ≤ 256 KiB and verifies against
  its digest; otherwise only the digest is sent and the agent fetches
  `blobs/{digest}`. The agent accepts bytes only if they hash to the Set's
  `resolved_set_digest` and their `contentHash`/`campId` match the Set.
- Management: OBSERVE_ONLY from the spec stream or the declared topology wins.
  `observe_fields` come from `PostureService.observeFields`.

## Event architecture

- **Leases:** durable subscription `cd:camp:<campId>`, partition = Camp, holder
  `<reconcilerId>/<holderId>` — the same key as the in-process transport
  (WP7), so a conductor and an agent can never both write one Camp (I4).
- **Reports:** lease renewal, then a fenced append to `cd-camp-status-<id>`
  (never the spec stream): `deployment.ReconcileStarted` (CONVERGING),
  `deployment.StatusObserved`, `deployment.Converged` /
  `deployment.ReconcileBlocked`, body schema `hobo.cd.reconcile-status/v1`,
  idempotency `<camp>:<fence>:<sha256(observation)>:<type>` (at-least-once
  safe). Attributes are limited to declared `observe_fields` and 16 KiB per
  resource.
- **Checkpoints:** fenced and monotonic (`commitCheckpoint`).
- **Read side:** `DesiredStateReader.changes` (WP4) is the projection the feed
  tails; the handler keeps no state of its own, so any Station replica can
  serve any request.

## Telemetry

`hobo.cd.feed.requests` (`route`, `status`), `hobo.cd.feed.request_ms`
(histogram), `hobo.cd.feed.frames` (`inline`), `hobo.cd.feed.responses`
(`end`, `frames`), `hobo.cd.feed.observations` (`status`),
`hobo.cd.feed.checkpoint_ms` (histogram). Load baseline
(`test/feed/load.test.ts`, 1,000 Camps / 50 agents, in-memory journal, 4 CPU
container): p99 frame ≈ 33 ms, p99 checkpoint ≈ 25 ms, 1.7 s total.

## Runbook

- **Agent sees `lease-held`.** Another reconciler (agent or conductor) holds
  `cd:camp:<id>`. It expires 30 s after its last renewal; if the holder is
  unexpected, revoke that reconciler.
- **`stale-fence` on reports.** The lease was taken over (expiry or another
  holder). The agent re-claims; nothing it wrote under the old fence landed.
- **Agent keeps re-reading the same frame.** It is not checkpointing; check
  `POST checkpoints` refusals (`checkpoint-regression` means it tried to go
  backwards — restart it so it resumes from the committed position).
- **`blob-missing` / `resolved-set-missing`.** Restore the blob into the
  artifact store or re-apply the Set; the Camp stays blocked until it verifies.
- **`blob-corrupt` / `resolved-set-mismatch`.** The stored bytes no longer hash
  to the digest; restore from a verified copy. Nothing is rebuilt (I1).
- **`attribute-undeclared` / `attribute-oversize`.** The agent reports more
  than the bound posture packs declare or more than 16 KiB per resource;
  upgrade the agent or narrow the packs.
- **Feed responses always end `long-poll` with no frames.** Nothing new since
  the checkpoint — expected. If a Set was applied, check that it landed on
  `cd-camp-<id>` (spec) and that the Station's desired-state projection tails.
- **High `hobo.cd.feed.request_ms`.** Check journal latency first (every
  request appends a DPoP replay record), then frame size (inline sets near
  256 KiB).
