# Patterns — ecosystem reference

> Captures of **techniques / methodologies / architectural patterns** relevant to HoBo, each with an analysis of how HoBo realizes (or should realize) it. Sibling to [`../technologies/`](../technologies/index.md) (tools) and [`../standards/`](../standards/index.md) (specs). Where a pattern has a canonical tool or standard, the entry cross-links it.

## Per-entry shape
Each file has: **What it is** · **Key elements** (the documentation) · **Relevance to HoBo** (the analysis — how HoBo implements it / which Plan-ADR owns it / gaps) · **Sources**.

## Index
| Pattern | What it is | File |
|---|---|---|
| **GitOps & runbook automation + artifact promotion** | Declarative, Git-driven delivery + event-driven runbooks + environment-promotion rules | [`gitops-runbook-promotion.md`](./gitops-runbook-promotion.md) |
| **Chaos engineering & chaos testing** | Deliberately injecting failure to validate resilience (steady-state, blast radius, game days) | [`chaos-engineering.md`](./chaos-engineering.md) |
| **Feature flags** | Decoupling deploy from release via runtime flags (rollout, kill-switch, experiments) | [`feature-flags.md`](./feature-flags.md) |
| **Runtime code-mutation persistence** | Persisting runtime/AI-generated code mutations back to source safely (the TS patch problem) | [`runtime-code-mutation-persistence.md`](./runtime-code-mutation-persistence.md) |
| **Service mesh (Istio / Linkerd / Envoy)** | Platform-owned identity/mTLS, traffic policy, resilience, telemetry between services — and how HoBo relocates it into the WIT membrane | [`service-mesh.md`](./service-mesh.md) |

> Related: **policy-as-code** (canonical tool [`../technologies/opa-rego.md`](../technologies/opa-rego.md), HoBo [Plan 29](../design/contracts-policy-flags.md#plan-29)); **consumer-driven contracts** (canonical tool [`../technologies/pact.md`](../technologies/pact.md), HoBo [Plan 29](../design/contracts-policy-flags.md#plan-29)).

## Sources & fair use
Third-party reference captures; factual surface quoted under fair use for commentary/analysis. Trademarks/copyright remain their owners'; not part of the HoBo product.
