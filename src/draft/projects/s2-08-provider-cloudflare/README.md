# S2-08 @hobo/provider-cloudflare draft POC (HOBO-623)

Draft traceability copy of the S2-08 Cloudflare provider slice. **Production code
will live in `packages/providers/provider-cloudflare/`** once S2-06 merges. This
tree promotes the provider-manifest and conformance-evidence flows from
[`providers-iac-build-adapters`](../../epic-proofs/providers-iac-build-adapters/)
and the HOBO-165 contract proof.

## Scope (in)

- Initial capability ports: **web/service** (Workers), **kv**, **objectStore** (R2)
- Equivalence-class mappings per port
- Typed `cloudflare.with.worker/r2/kv` option builders
- Published Capability Manifest (`capabilities.json`, `auth.json`, `cost.json`, FR-031)
- hello-bindle resource realization (Worker + R2 + KV)
- Recorded-fixture provider-capability conformance (local + camp tags)

## Scope (out)

- Live Terraform/Wrangler execution against real Cloudflare accounts
- Production `packages/providers/provider-cloudflare/` workspace slot (blocked on S2-06)
- D1, Queues, DNS, Hyperdrive (retained in HOBO-165 contract proof only)

## Validation

```bash
pnpm --prefix src/draft/projects/s2-08-provider-cloudflare build
pnpm --prefix src/draft/projects/s2-08-provider-cloudflare test
```

## Architecture evidence

- `data-models/` — protobuf + CUE constraints for capability manifest and provider ports
- `contracts/provider-cloudflare-boundary.pact.json` — ProviderCloudflareBoundary pact
- `ADR.md` — parse-don't-validate and realize-emission evidence

## Promotion path

Blocked on HOBO-621 (S2-06 `@hobo/iac-pulumi`). When unblocked, promote to
`packages/providers/provider-cloudflare/` with credentialed CI conformance lane.

## Cascade absorption

The referenced `hobo-realize-emission-contract` and
`provider-cloudflare-contract` leaves only repaired their JSON boundaries
(cloneAsJson crossings, a build-reference parser in place of an invalid type
predicate, and the local emission context aligned to the upstream JsonValue
contract). Realization output, the boundary pact, and this project's evidence
are unchanged.
