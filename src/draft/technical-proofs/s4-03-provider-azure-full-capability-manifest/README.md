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
  ([Plan 06](../../../../docs/design/ai-native-agent-auth.md#plan-06))
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

## Architecture Evidence

- `architecture/` — protobuf + CUE constraints
- `architecture/pacts/` — PACT boundary contract
- `ADR.md` — parse-don't-validate and event-architecture evidence

## Maintenance

Source issue: HOBO-639. Proof index:
[`docs/design/proofs/hobo-639-provider-azure-full/index.md`](../../../../docs/design/proofs/hobo-639-provider-azure-full/index.md).
