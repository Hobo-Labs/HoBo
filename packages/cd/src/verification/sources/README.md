# Health sources (`@hobo/cd/verification`, WP9)

Implementations of the frozen `HealthSource` port. `createHealthSources({ http,
credentials, posture? })` returns one per kind; vendor names live only in this
folder (I11). Every request goes through the injected `HttpTransport` with a
10 s timeout and a 4 MiB body bound; nothing reads a global `fetch`.

| Kind | File | Request | `query` | Cohort selection |
|---|---|---|---|---|
| `PROMETHEUS` | `prometheus.ts` | `GET /api/v1/query_range`, step = max(15 s, window/60), start/end aligned to the step | PromQL | series label `cohort_label` = `canary`/`baseline` |
| `HOBO_METERING` | `hobo-metering.ts` | `GET <endpoint>/v1/metering/series?meter&camp&from&to&cohort` | meter name | `cohort` parameter |
| `HTTP_JSON` | `http-json.ts` | `GET <endpoint>?from&to&camp&<cohort_label>=<cohort>` | RFC 6901 pointer to a numeric array | query parameter |
| `DATADOG` | `datadog.ts` | `GET /api/v1/query?from&to&query` | metric query grouped by the tag | `tag_set` contains `<cohort_label>:<cohort>` |
| `NEW_RELIC` | `newrelic.ts` | `POST /graphql` (NerdGraph), NRQL as a variable + `SINCE/UNTIL` from the window; `?accountId=` on `endpoint_ref` | NRQL with `FACET <cohort_label> TIMESERIES`, one aggregate | FACET attribute |
| `CLOUDWATCH` | `cloudwatch.ts` | `POST /` GetMetricData, AWS JSON 1.0, SigV4 (`sigv4.ts`), follows `NextToken` (≤ 10 pages) | JSON `{namespace, metricName, stat, period, dimensions}` | extra dimension `<cohort_label>` |
| `HOBO_POSTURE` | `hobo-posture.ts` | `PostureSeriesReader` (journal projections) | `noncompliant_ratio` or `shadow_divergence_count`; `endpoint_ref` = candidate Rail digest | per Camp; no baseline |

Cohort values are `canary` and `baseline`; `ALL` selects everything. Series
are sorted by their label set before flattening, so the samples never depend
on the order a source answers in (I8). `NaN` and `null` points are no sample;
`±Inf` is kept so the verdict rejects it as an invalid sample.

**Credentials.** `credential_ref` resolves through `CredentialResolver` with
scope `cd.verification:<campId>`. For HTTP sources the resolved map is sent as
request headers (`authorization`, `DD-API-KEY`/`DD-APPLICATION-KEY`,
`API-Key`); for CloudWatch it is `{ accessKeyId, secretAccessKey,
sessionToken? }` used for signing. Credentials are never recorded, logged or
echoed; a resolver error is reported as `health-source-credential-unavailable`
without its message.

**Posture.** `informVerificationSpec({ railDigest })` is the R12 default for
an INFORM node: noncompliant ratio ≤ 2 % (MAX) and zero shadow divergences
(SUM) over 24 h. A window without compliance records has no samples and
FAILs.

## Contracts

Hand-authored consumer PACTs in `test/verification/pacts/` (Prometheus,
Datadog, New Relic, CloudWatch, HTTP JSON, HoBo metering), verified by
`test/verification/sources/pacts.test.ts`. They are not provider-verified.
SigV4 is pinned against botocore in `test/verification/sources/sigv4.test.ts`.

## Runbook

| Refusal | Meaning | Action |
|---|---|---|
| `health-source-unconfigured` | No source of the query's kind is wired. | Wire it via `createHealthSources` (posture needs a `PostureSeriesReader`). |
| `health-source-endpoint-invalid` | `endpoint_ref` is not https, carries userinfo, is not a regional CloudWatch host, lacks `?accountId=` (New Relic), or is not a Rail digest (posture). | Fix the spec. |
| `health-source-query-invalid` | NRQL carries its own `SINCE/UNTIL` or several aggregates; CloudWatch query is not the JSON stat; pointer does not start with `/`; unknown posture series. | Fix the query. |
| `health-source-cohort-label-missing` | A split cohort was asked for but the query declares no `cohort_label`. | Declare it and make the query keep that label/tag/attribute/dimension. |
| `health-source-credential-unavailable` | The credential did not resolve (or lacks AWS keys). | Store it where the reconciler runs; check the scope `cd.verification:<campId>`. |
| `health-source-http-error` | Non-2xx, GraphQL errors, or a CloudWatch Forbidden/InternalError status. | Check keys, quotas, the query. Retried each tick until the deadline. |
| `health-source-transport-failed` | Timeout, guard refusal or reset. | Check network policy and the transport guard allowlist. Retried. |
| `health-source-response-invalid` | The answer does not match the source's contract. | Check the API version against the PACT; retried. |

Live lane: the credential-gated Prometheus lane (plan 0024 R16) is owned by
WP20; it runs the Prometheus source against a real server and skips with a
visible reason when no endpoint is configured.
