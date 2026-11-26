# @hobo/status-page contracts

`pacts/status-page-projection.pact.json` records the consumer expectations of
the status-page read model as PACT interactions:

1. **Fold shape** — `slo.Measured` / `incident.*` / `maintenance.*` /
   `statuspage.*` events fold into scope-keyed rows (`project:<id>`,
   `tenant:<id>`, or an explicit `data.scopeKey`).
2. **Publish gate** — a public publish requires a non-empty declared-public
   component allowlist and yields a `statuspage.Published` audit payload with
   the content hash of the exact rendered bytes.

Honesty note: these pacts document the projection/publish contract executed by
the unit tests in `test/`; they are consumer evidence, not proof of a live
HTTP provider. The projection is in-process (`defineProjection` from
`@hobo/data`), and the HTTP shapes here describe the equivalent control-api
surface a provider would expose.
