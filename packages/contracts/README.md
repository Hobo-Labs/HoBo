# @hobo/contracts

The Contract IR + `can-deploy` compatibility engine + the composed **Gatekeeper**
for HoBo's contract and policy planes (S2-07). See
[`ARCHITECTURE.md`](./ARCHITECTURE.md); design source:
[`docs/design/contracts-policy-flags.md`](../../docs/design/contracts-policy-flags.md).

The Gatekeeper sits in front of every deploy and composes four gates into one
explainable, machine-readable decision — the can-deploy contract check, the
`@hobo/policy` policy decision (imported and **run**, never reinvented), an
obligation check, and a cost/quota check. Every evaluation records a
`policy.Decided` fact even when it allows.

**Effects + resiliency (ADR-0136):** optional `effects: EffectSpec` (Verse-inspired
purity lattice + domain I/O) and `resilience: ResilienceProfile` (secondary
visibility layer; deterministic retry; never retries `policy.Decided` / terminal).
Export via `toEffectManifest` / `formatContractDescribe`; harness integration in
`@hobo/contract-harness`.

```ts
import {
  createBoundaryContract,
  checkCompatibility,
  evaluateGatekeeper,
  pureEffects,
  createResilienceProfile,
  formatContractDescribe,
  toEffectManifest,
} from "@hobo/contracts";

// Contract IR: is api@v3 compatible with what worker@v2 expects?
const prev = createBoundaryContract({ version: "1.2.0" });
const next = createBoundaryContract({
  version: "3.0.0",
  requiredShape: { format: "json-schema", requiredFields: ["id"], providedFields: ["id"] },
});
checkCompatibility(prev, next); // -> { kind: "breaking", reasons: [...] }

// Gatekeeper: contract + policy + obligations + cost/quota -> one decision.
const decision = evaluateGatekeeper({
  request: {
    subject: { kind: "agent", id: "agent:deployer" },
    action: "hobo:delta:promote",
    resource: { kind: "deployment", id: "deployment:checkout-prod" },
    phase: "apply",
    context: { target: "prod" },
  },
  deployedState: { contracts: [prev] },
  candidate: { plan: { objective: "cost", resources: [] }, contracts: [next] },
  costQuota: { quota: "deployments/day", used: 7, limit: 20 },
});
// decision.decision === "deny", decision.reasons[0].code === "required-field-removed"
// decision.policyDecided.type === "policy.Decided"  (recorded even on allow)
```

Composes [`@hobo/policy`](../policy) and reuses the port vocabulary from
[`@hobo/core`](../core); the `DeploymentPlan` a deploy gates over is mirrored
structurally so this package stays inward of `@hobo/cloud`.
