# HOBO-67 Resource Collection Engine Proof

This executable proof backs [PLAN-02](../../sdk-api.md#plan-02), [PLAN-21](../../authoring-resources-wiring.md#plan-21), [PLAN-19](../../worked-example.md#plan-19), and the usage-inferred grant portion of [ADR-0069](../../adr/01-architecture-core.md#adr-0069).

The proof lives in [`../../../src/draft/technical-proofs/resource-collection-engine-contract`](../../../../src/draft/technical-proofs/resource-collection-engine-contract).

**POC status (HOBO-606):** implemented as an independent draft POC on branch `cursor/hobo-606-hobo-agent-workflow-763f`; promotion to `packages/collector` (`@hobo/collector`) follows S1-13/S1-14 merge.

It verifies:

- a `kv` + `api` IfC Bindle collects into a valid `hobo.manifest/v1`;
- bind edges become manifest links and observed bind keys;
- handle calls infer used verbs into manifest `allow` / `usage`;
- `bindle.ResourcesCollected` and `bindle.ManifestProduced` facts carry the manifest payload;
- manifest content hashes and event IDs are deterministic across equivalent runs;
- missed branch declarations are returned as collection-coverage failures;
- collection-time network and clock side effects are ignored for deterministic collection;
- duplicate resource IDs fail closed.
