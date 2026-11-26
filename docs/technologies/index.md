# Technologies — ecosystem reference

> Faithful captures of **concrete tools / libraries / products / engines** in HoBo's ecosystem, each with an analysis of its relevance to the [design suite](../design/index.md). Sibling to [`../standards/`](../standards/index.md) (open specs) and [`../patterns/`](../patterns/index.md) (techniques), and to [`../competitors/`](../competitors/index.md) (head-on/adjacent products). Many of these are candidates to sit **behind a HoBo WIT port as an optional capability provider** rather than being baked into the model — the recurring HoBo stance.

## Per-entry shape
Each file has: **What it is** · **Key features** (the documentation) · **Relevance to HoBo** (the analysis — validates / informs / adopt-behind-a-port / gap, with Plan/ADR links) · **Sources**.

## Index
| Technology | What it is | File |
|---|---|---|
| **CUE** | Typed config/data/validation language (config superset of JSON) | [`cue.md`](./cue.md) |
| **Microsoft Trace** | Framework for tracing + optimizing LLM/agent workflows (auto-diff for prompts/code) | [`microsoft-trace.md`](./microsoft-trace.md) |
| **Agent Lightning** | Microsoft RL/optimization trainer for agents (decouples training from execution) | [`agent-lightning.md`](./agent-lightning.md) |
| **agentV** | Local-first agent-evals framework; deterministic + LLM graders over stored traces, per-metric scores | [`agentv.md`](./agentv.md) |
| **DSPy** | Declarative framework for programming (not prompting) LMs; compiles + optimizes pipelines | [`dspy.md`](./dspy.md) |
| **HolmesGPT / CNCF SRE Agent** | AI SRE / root-cause investigation agent over observability + runbooks | [`holmesgpt-sre-agent.md`](./holmesgpt-sre-agent.md) |
| **StackStorm (st2)** | Event-driven automation / runbook engine ("IFTTT for ops") | [`stackstorm.md`](./stackstorm.md) |
| **OpenStack** | Open-source IaaS cloud platform (compute/network/storage) | [`openstack.md`](./openstack.md) |
| **OPA / Rego** | Open Policy Agent + the Rego policy language (policy-as-code engine) | [`opa-rego.md`](./opa-rego.md) |
| **Pact** | Consumer-driven contract testing framework + Pact Broker | [`pact.md`](./pact.md) |
| **Varlock** | `.env`-native secrets/config with schema + providers (`@env-spec`) | [`varlock.md`](./varlock.md) |
| **Pivotal Cloud Foundry (PCF)** | The original opinionated app PaaS (`cf push`, buildpacks, droplets) | [`cloud-foundry-pcf.md`](./cloud-foundry-pcf.md) |
| **Prometheus AlertManager** | Alert routing/grouping/silencing/inhibition for Prometheus | [`prometheus-alertmanager.md`](./prometheus-alertmanager.md) |
| **Tailscale** | WireGuard-based zero-config mesh VPN (tailnets, Funnel, grants); opt-in managed-mesh adapter; WireGuard is the ADR-0122 portable floor | [`tailscale.md`](./tailscale.md) |
| **Cedar** | AWS open-source authorization language + formally verified engine; optional `policy-engine` provider beside OPA | [`cedar.md`](./cedar.md) |
| **Temporal** | Durable-execution platform (workflows-as-code, event-history replay); the benchmark HoBo's durable runtime is measured against | [`temporal.md`](./temporal.md) |
| **Argo CD** | CNCF-graduated declarative GitOps CD (Application CRD, sync waves); reference target of GitOps publisher mode | [`argo-cd.md`](./argo-cd.md) |
| **Flux CD** | CNCF-graduated GitOps toolkit (source/kustomize/helm controllers, OCI artifacts) | [`flux-cd.md`](./flux-cd.md) |

> See also: the AI-training trio (Trace · Agent Lightning · DSPy) directly informs HoBo's **`training-engine`** ([ADR-0025](../design/adr/03-data-plane.md#adr-0025)/[Plan 23](../design/generated-stack.md#plan-23)); OPA/Rego and Pact are the canonical **optional providers** behind HoBo's policy ([Plan 29](../design/contracts-policy-flags.md#plan-29)) and contract ([Plan 29](../design/contracts-policy-flags.md#plan-29)) ports.

## Sources & fair use
These are **third-party reference captures**. Each file links its upstream source; factual interface/feature surface is quoted under **fair use for commentary, comparison, and interoperability analysis**, limited to what's needed to map each to HoBo. All trademarks/copyright remain their owners'; nothing here grants rights to that material, and these captures are not part of the HoBo product.
