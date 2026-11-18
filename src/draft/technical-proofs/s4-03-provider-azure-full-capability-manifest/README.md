# S4-03 Azure Full Provider + Capability Manifest POC

Draft POC for HOBO-639 (`@hobo/provider-azure` second full provider + Capability
Manifest), mirroring S4-02 scope as an independent proof under
`src/draft/technical-proofs/`.

Promotes Azure fixtures from
[`providers-iac-build-adapters`](../../epic-proofs/providers-iac-build-adapters/)
and extends the seed
[`provider-azure-contract`](../provider-azure-contract/) to the full S4 bindle
port catalog.

## Scope

- Full capability port catalog: `web`, `service`, `kv`, `bucket`, `queue`,
  `topic`, `sql`, `secret`
- Equivalence classes mapping bindle ports to Azure resource classes
- Typed `azureFull.with.*` builders per port
- `auth.json` with `workload-identity-federation` for keyless brokering
  ([Plan 06](urn:hobo:requirement:ai-native-agent-auth#plan-06))
- Pulumi realization via `@hobo/iac-pulumi` driver intent
- Registry ingest seam for S3-04 capability manifest discovery
- Provider-capability conformance (seed-mapped ports) + extended local checks
  for `web`/`topic`/`secret`

## Out of scope

- Production `packages/providers/provider-azure/` (deferred until S4-01 merges)
- Real Azure SDK/Pulumi execution or live keyless Camp runs
- AWS S4-02 production package or cross-provider Planner negotiation

## Run

```bash
pnpm --prefix src/draft/technical-proofs/s4-03-provider-azure-full-capability-manifest test
```

## Executable evidence
- `architecture/` — protobuf + CUE constraints
- `architecture/pacts/` — PACT boundary contract

## Maintenance

Source issue: HOBO-639. Proof index:
[`urn:hobo:proof:hobo-639-provider-azure-full`](urn:hobo:proof:hobo-639-provider-azure-full).
