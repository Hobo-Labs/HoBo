# `@hobo/cd/inventory` — Camp inventory (WP22: D19, D20, I18, I19)

`createCampInventory` implements the frozen `CampInventory` port
(`../ports.ts`). Every Camp has a `CampStatusRecord` with conditions, observed
claims and taints; Camp sets group Camps for Placement.

## Event architecture

| Stream | Events | Body |
|---|---|---|
| `cd-camp-inventory-<campId>` | `camp.StatusChanged` | full `CampStatusRecord`; `meta.contact` holds Station-observed contact times |
| | `camp.Tainted`, `camp.Untainted` | `TaintRecord` (audit; appended atomically with the `StatusChanged` they explain) |
| | `camp.ManagementChanged` | partial `CampStatusRecord` (`campId`, `management`) (audit) |
| `cd-campset-<name>` | `campset.Defined` | `CampSetRecord` |

- **Actor:** one per Camp. Commands catch the in-memory projection up from
  the stream, then append with `expectedSeq` (CAS) and retry on conflict, so
  several Station replicas stay consistent. The fold reads only
  `camp.StatusChanged`.
- **Commands:** `observe`, `taint`, `untaint`, `manage`, `defineSet`, `tick`.
  `taint`/`untaint`/`manage`/`defineSet` are governed (`camp.taint`,
  `camp.untaint`, `camp.manage`, `campset.define`); a proposal-only principal
  (an agent) is refused with `proposal-only`.
- **Read model:** `status`, `list`, `sets`, `snapshot`. `snapshot(campSets)`
  is canonical (Camps sorted by id, regions sorted, conditions/claims/taints
  sorted) and its `digest` is the sha256 of the canonical JSON of the sets and
  views. A declared Camp with no recorded status is shown as never contacted
  (`REACHABLE=UNKNOWN`, `NO_PLACE hobo.cd/unreachable`), with empty times so
  the digest does not depend on the clock.

## Derivation (`derive.ts`, pure)

`tick` scans the journal (one `readAll` cursor) for reconcile events the
Station appended on `cd-camp-status-<id>` (`deployment.ReconcileStarted`,
`StatusObserved`, `Converged`, `ReconcileBlocked`). Each is contact at the
tick's injected `now`; one carrying a `fenceToken` is lease activity. Agent
clocks are never read. Station-sourced `observe` reports of `REACHABLE`,
`LEASED` and `CREDENTIAL_VALID` feed the same contact state.

| Condition (source `STATION`) | TRUE | FALSE | Automatic `NO_PLACE` key |
|---|---|---|---|
| `REACHABLE` | contact within 90 s | no contact for > 90 s, or a Station report | `hobo.cd/unreachable` (also while UNKNOWN: never contacted) |
| `LEASED` | lease activity within 30 s | lease older than 30 s, or a Station `LEASED=FALSE` | `hobo.cd/lease-lost` |
| `CREDENTIAL_VALID` | SVID expiry more than 2 min away | refresh failed, or ≤ 2 min remain unrefreshed | `hobo.cd/credential-invalid` |
| `CLAIMS_CONSISTENT` | no claim contradicts declared topology | a claim contradicts it (`region`, `provider`, `yard`, `station`, `env`, `jurisdiction`, `label:<k>`) | `hobo.cd/claims-inconsistent` |

`CREDENTIAL_VALID` exists only for Camps whose SVID is reported (agent mode):
WP11 reports issuance/refresh as `observe({source: STATION, conditions:
[CREDENTIAL_VALID TRUE, reason "expires-at:<RFC 3339>"]})` and a failed
refresh as `CREDENTIAL_VALID FALSE`. A *silent* failure (no refresh, no
report) turns FALSE on the first tick at which ≤ 2 min remain.

Automatic `NO_PLACE` taints are added and cleared by the inventory only; the
`hobo.cd/` prefix is reserved and `untaint` refuses them (`taint-automatic`).

### Claims narrow, never grant (I19)

Claims (from `observe` or the latest reconcile observation via
`DesiredStateReader.status`) are stored with `reportedBy`. A contradiction
sets `CLAIMS_CONSISTENT=false` and taints `NO_PLACE`. Selectors, residency and
Rail bindings read declared topology only.

### `NO_RUN`

Only from:

- an operator: `taint` with source `OPERATOR` and a human (`user`) principal;
- a Rail rule: Rail `delivery.failover.automatic` and at least
  `required_signals` (default 2) independent negative signals — distinct
  sources with a FALSE condition — one of them `STATION`. Agent self-reports
  (`RECONCILER`) never count. The automatic key is `hobo.cd/failed`; it is
  never cleared automatically (no automatic failback, D23).

An agent principal may only `observe` as `RECONCILER`.

- **Event store / read store:** the durable event store (`DurableEventStore`,
  SQLite or Postgres) is the only record; the in-memory projection is the
  read store, rebuilt from the journal on start. `snapshot` is a derived,
  digest-addressed read, not a persisted snapshot; no store snapshot is
  needed because each per-Camp stream is short (one event per status change).
- **Parse, don't validate:** commands pass through `parseCampSet`,
  `parseTaint`, `parseClaims`, `parseConditions` and `parseSelector`, which
  return derived types (`ParsedCampSet`, `ParsedTaint`, `ParsedClaim`,
  `ParsedSelector`, brands over the generated records) or typed refusals.

## Telemetry

`hobo.cd.inventory.status_changes` (counter), `hobo.cd.inventory.taints`
(counter; `effect`, `key`, `change=added|cleared`),
`hobo.cd.inventory.camps` (gauge per tick; `taint=any|NO_PLACE|NO_RUN`),
`hobo.cd.inventory.campsets_defined` (counter). Telemetry is advisory: a
failing sink never fails a command.

## Typed failures

| Code | Meaning | Remediation |
|---|---|---|
| `camp-unknown` | Camp not in declared topology | declare it in its Yard first |
| `source-invalid` / `source-not-permitted` | unspecified source; agent reporting as non-`RECONCILER`; non-human `OPERATOR` | report with the principal that owns the source |
| `condition-invalid` / `claim-invalid` | malformed or duplicated entries | fix the report |
| `taint-invalid` / `taint-reserved` / `taint-automatic` | bad key/effect; `hobo.cd/` key; untaint of an automatic taint | see message |
| `no-run-not-permitted` | `NO_RUN` without an operator or a satisfied Rail rule | operator taint, or enable the Rail rule |
| `campset-invalid` / `campset-empty` / `selector-unsupported` | bad name; no selector and no ids; selector names Bindles | fix the definition |
| `proposal-only`, `policy-denied` | authorization | ask a granted principal |

## Runbook

- **Camp shows `hobo.cd/unreachable` but its reconciler runs.** The Station
  has not appended a reconcile status event for it in 90 s. Check the agent's
  feed connection and `deployment.*` events on `cd-camp-status-<id>`. After a
  Station restart, contact recorded before the restart counts only until 90 s
  past its recorded time; a live reconciler clears the taint within one
  renewal (10 s).
- **`hobo.cd/credential-invalid`.** Look at the condition reason:
  `svid-refresh-failed` (refresh refused — check identity issuer and DPoP
  clock skew) or `svid-expiring-unrefreshed:<expiry>` (the agent stopped
  refreshing — restart it; re-enroll if its key was revoked).
- **`hobo.cd/claims-inconsistent`.** The reason lists the contradicting
  `name=value`. Either the agent runs somewhere other than declared (move it
  or fix the topology through a `topology` Delta) or it misreports. The Camp
  is never placed while this holds.
- **`hobo.cd/failed` (`NO_RUN`).** Added by the Rail rule; the reason lists
  the signal sources. Investigate, then `untaint` it as an operator; nothing
  clears it automatically.
- **A Camp set lists the wrong Camps.** `list({campSets: [name]})` shows
  membership; selectors read declared labels, env types, ids and the
  jurisdictions of declared regions (every region must match).
