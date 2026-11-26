# Standards — ecosystem reference

> Faithful captures of **open specifications / schemas / standards** HoBo should align with or adopt, each with an analysis of its relevance to the [design suite](../design/index.md). Sibling to [`../technologies/`](../technologies/index.md) (tools) and [`../patterns/`](../patterns/index.md) (techniques). HoBo's bet is to **speak existing standards** at its boundaries (events, telemetry, SLOs, GitOps, policy decisions, security schema) rather than invent proprietary ones — these are the standards in scope.

## Per-entry shape
Each file has: **What it is** · **Key features** (the documentation) · **Relevance to HoBo** (the analysis — adopt-at-the-boundary / emit-this / align-our-model, with Plan/ADR links) · **Sources**.

## Index
| Standard | What it is | File |
|---|---|---|
| **CloudEvents** (CNCF) | Vendor-neutral spec for describing event data in a common envelope | [`cloudevents.md`](./cloudevents.md) |
| **OpenSLO** | Open spec (YAML) for declaring SLOs/SLIs/error budgets as code | [`openslo.md`](./openslo.md) |
| **OpenGitOps** (CNCF) | The 4 principles defining GitOps (declarative, versioned, pulled, reconciled) | [`opengitops.md`](./opengitops.md) |
| **CNCF Serverless Workflow** | Vendor-neutral DSL for declaring workflows/orchestration | [`serverless-workflow.md`](./serverless-workflow.md) |
| **OTel · OTLP · OTel-GenAI · OpenInference** | Telemetry standards: the OpenTelemetry model + wire protocol + GenAI semconv + AI-span convention | [`otel-otlp-genai-openinference.md`](./otel-otlp-genai-openinference.md) |
| **OpenFeature** (CNCF) | Vendor-neutral feature-flag evaluation API + provider model | [`openfeature.md`](./openfeature.md) |
| **OCSF** | Open Cybersecurity Schema Framework — normalized schema for security events | [`ocsf.md`](./ocsf.md) |
| **FOCUS & OpenCost** (FinOps Foundation / CNCF) | Normalized cost/usage billing-data spec + cost-allocation spec | [`focus-opencost.md`](./focus-opencost.md) |
| **CNAB** (JDF) | Signed multi-artifact application bundles + invocation images; packaging/signing lessons only (ADR-0144) | [`cnab.md`](./cnab.md) |
| **OAM** (+ KubeVela) | Application/Component/Trait/Scope app-delivery spec; vocabulary alignment + wadm render target, never the model | [`oam.md`](./oam.md) |
| **OSCAL** (NIST) | Machine-readable control catalogs/implementations/assessments; vocabulary for control→evidence packs, emit-at-boundary | [`oscal.md`](./oscal.md) |

> See also: the **feature-flags pattern** lives in [`../patterns/feature-flags.md`](../patterns/feature-flags.md) (OpenFeature is its standard); telemetry standards underpin both observability ([Plan 5](../design/reliability-observability-cost.md#plan-05)) and the training reward signal ([Plan 23](../design/generated-stack.md#plan-23)); cost standards ground showback ([ADR-0039](../design/adr/02-identity-security.md#adr-0039)) and the [FinOps budget-routing control plane](../design/finops-budget-routing-control-plane.md#standards-baseline).

## Sources & fair use
Third-party reference captures; factual spec surface quoted under fair use for commentary/interoperability analysis, limited to what's needed to map each to HoBo. Trademarks/copyright remain their owners'; not part of the HoBo product.
