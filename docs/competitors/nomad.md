---
type: Competitive Reference
title: "HashiCorp Nomad + Nomad Pack — Competitor Reference"
description: "HashiCorp Nomad is a workload scheduler/orchestrator; Nomad Pack adds reusable packaging for Nomad job specs."
tags: [hobo, competitors]
competitor:
  slug: nomad
  name: "Nomad"
  aliases: ["nomad pack", "hashicorp nomad"]
  primary_category: runtime-substrates
  categories: [runtime-substrates, platform-orchestrators]
  directness: overlapping
  role: "workload scheduler/orchestrator plus jobspec packaging — direct scheduler/control-plane competitor and provider target"
  posture: [borrow, provider-target, benchmark]
  hobo_surface: [provider-matching, runtime-portability, reconciliation]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://developer.hashicorp.com/nomad/docs
    - https://github.com/hashicorp/nomad
---

# HashiCorp Nomad + Nomad Pack — Competitor Reference

> Captured for HoBo competitive analysis. Sources: HashiCorp Developer Nomad docs and the `hashicorp/nomad-pack` repository, researched July 1, 2026. This file documents **Nomad** and **Nomad Pack** faithfully; the HoBo↔Nomad mapping/parity tracker lives in the [primitive mapping](#primitive-mapping) section below.

## What it is

- **Nomad:** a simple, flexible scheduler/orchestrator for containers, binaries, batch jobs, and other workloads across on-prem and cloud infrastructure.
- **Nomad Pack:** a templating/packaging layer for Nomad job specifications: deploy popular apps, reuse internal patterns, and share jobspecs through registries.
- **Paradigm:** operations-first workload orchestration. Developers or platform teams submit HCL jobspecs; Nomad schedules allocations onto client nodes and manages lifecycle, placement, networking, service registration, and rollout behavior.
- **Target user:** infrastructure/platform teams that want a lighter-weight alternative or complement to Kubernetes, especially for mixed workloads: Docker, raw executables, Java, QEMU, batch, system jobs, and legacy services.
- **Relation to HoBo:** direct competition at the **scheduler/runtime/control-plane** layer, especially when paired with Nomad Pack as the reusable app packaging story. It is not an Infrastructure-from-Code platform like Nitric; it is a programmable workload fabric HoBo could either compete with or target as a provider/host adapter (dispositioned accepted-future in [ADR-0106](../design/adr/01-architecture-core.md#adr-0106)).

## Architecture

```text
Nomad jobspec / Nomad Pack
  → Nomad HTTP API / CLI
  → Nomad server cluster (Raft state, scheduling, evaluations, deployments)
  → Nomad client agents (drivers, task lifecycle, alloc dirs, networking)
  → task drivers (docker, exec, raw_exec, java, qemu, custom plugins)
  → integrations (Consul service discovery/mesh, Vault, CNI, CSI, autoscaler)
```

**Core hierarchy.** A Nomad **job** contains one or more **groups**; each group contains one or more **tasks**. Groups are placement units: tasks in a group are co-located on the same client. A running placement is an **allocation**.

**Scheduling model.** Jobs are submitted to servers; servers produce evaluations and placement plans; clients run allocations through task drivers. Placement can be shaped with datacenters, regions, node pools, constraints, affinities, spreads, priorities, reschedule/restart policies, and resource reservations.

**Workload types.** Nomad covers service jobs, batch jobs, system jobs, parameterized/on-demand jobs, periodic jobs, and dispatch-style runs. This is broader than serverless-backend frameworks: Nomad is a general scheduler.

**Integration-first, not batteries-included cloud resources.** Nomad intentionally delegates service mesh/discovery to Consul, secrets to Vault or Nomad Variables/templates, storage to CSI/host volumes, networking to CNI/host networking, autoscaling to Nomad Autoscaler, and infrastructure provisioning to external IaC/cluster management.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **Job** | The unit of work, declared in HCL jobspec: groups of tasks with constraints and update strategy |
| **Task group** | Co-scheduled tasks sharing a network namespace and allocation |
| **Task driver** | How a task actually runs — Docker, `exec`, Java, QEMU, or a custom driver |
| **Allocation** | A scheduled instance of a task group on a specific client node |
| **Constraint / affinity / spread** | Declarative placement controls the scheduler evaluates |
| **Nomad Pack** | Reusable, parameterized jobspec packaging |
| **Server / client** | The Raft-backed scheduler cluster and the agents that run allocations |

The mental model is **one scheduler, many workload shapes**. Nomad's distinguishing decision is that
containers are one driver among several: it schedules binaries, JVMs and VMs with the same
primitives, which is why it fits estates Kubernetes does not.

## How it competes with HoBo

| Contested HoBo surface | The contest |
| ---------------------- | ----------- |
| `provider-matching` | **The closest analog to HoBo's matching in this cohort** — constraints, affinities and spread are a declarative placement language the scheduler evaluates |
| `runtime-portability` | Multiple task drivers, so the same scheduler covers heterogeneous workloads |
| `reconciliation` | Allocation lifecycle and rescheduling |

[`lineage.md`](../design/lineage.md) records Nomad as a **pillar, pivoted**: the heterogeneous
scheduling and federation intent are taken, realized through the wasmCloud lattice and the
Junction/Yard/Camp hierarchy rather than through a Nomad cluster.

## Feature surface

### Jobspec model

| Surface                                      | What Nomad provides                                                                                                                                                   | HoBo-relevant reading                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `job`                                        | Top-level HCL/JSON unit; region/datacenters/namespace/type/priority/constraints/affinity/spread/update/migrate/periodic/parameterized metadata.                       | Explicit deploy spec, not inferred from app code.                          |
| `group`                                      | Co-located tasks; count, scaling, networks, services, volumes, restart/reschedule/ephemeral disk, Consul/Vault blocks.                                                | Closest analog to a HoBo service group/Camp placement unit.                |
| `task`                                       | Runnable workload with `driver`, `config`, `env`, `resources`, `template`, `artifact`, `service`, `volume_mount`, `identity`, lifecycle hooks.                        | Broad workload support, less typed app-resource model.                     |
| `service`                                    | Registers services with Nomad or Consul; supports health checks, tags/meta, canary tags/meta, Connect sidecars/gateways, workload identity for Consul service tokens. | Strong service-discovery + rollout integration.                            |
| `network`                                    | Dynamic/static port allocation, host/bridge/CNI modes, port labels, DNS.                                                                                              | Good low-level networking control.                                         |
| `resources`                                  | CPU, memory, memory max, device resources (e.g. GPU through device plugins).                                                                                          | Scheduler resource constraints, not app-level resource ports.              |
| `template`                                   | Renders config/env/files from variables, Consul KV, Vault secrets; can signal/restart tasks on change.                                                                | Powerful config injection but not parse-don't-validate typed domain input. |
| `artifact`                                   | Downloads artifacts before task start.                                                                                                                                | Useful legacy/binary deployment path.                                      |
| `volume` / `volume_mount`                    | Host volumes and CSI volumes.                                                                                                                                         | Storage attachment, not portable data abstraction.                         |
| `update`, `migrate`, `restart`, `reschedule` | Rolling updates, canaries, health gates, allocation migration, task restart, failed-allocation rescheduling.                                                          | Mature workload lifecycle controls HoBo must match in operations plane.    |
| `periodic` / `parameterized`                 | Cron-like jobs and dispatched parameterized jobs.                                                                                                                     | Overlaps HoBo schedules/jobs.                                              |

### Workload drivers

| Driver class        | Typical use                      | Competitive note                                                                        |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Docker              | Container workloads.             | Kubernetes-like container hosting without Kubernetes API complexity.                    |
| Exec/raw exec       | Binaries and scripts.            | Stronger legacy/non-container story than many PaaS/serverless systems.                  |
| Java                | JVM workloads.                   | Legacy enterprise fit.                                                                  |
| QEMU                | VM-like workloads.               | Bridges container and VM scheduling.                                                    |
| Custom task drivers | Plugin-defined runtimes/devices. | Extensible, but operator-authored plugin path rather than HoBo's WIT-conformance model. |

### Service discovery, mesh, and networking

Nomad can register services into either Nomad's native service discovery or Consul. Service blocks may live at task or group level, include TCP/HTTP checks for the Nomad provider, and expose richer Consul options such as gRPC/script checks, Connect service mesh sidecars, ingress/terminating/mesh gateways, tags/meta, weighted DNS, canary metadata, and workload identity for Consul service tokens.

**Lifecycle nuance:** service/check updates can be applied without restarting a task; during task shutdown Nomad deregisters services first, optionally waits for `shutdown_delay`, then signals/kills the task. That gives Nomad an operations-grade traffic-draining story.

### Security, identity, and secrets

| Surface           | Nomad capability                                                                                                         | HoBo comparison cue                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| ACLs              | Namespaces, policies, roles/tokens, scoped capabilities for jobs, nodes, variables, plugins, exec, etc.                  | Mature operator RBAC; HoBo needs equivalent project/Yard/Camp RBAC plus agent principals.      |
| Workload Identity | JWT identity for tasks/services; current Vault/Consul integrations use workload identity rather than static tokens.      | Close to HoBo's workload identity direction, but not agent-native by default.                  |
| Nomad Variables   | Encrypted configuration data in Nomad state; path-scoped ACLs; task identity grants automatic access to job-owned paths. | Convenient built-in config/secret-ish store, though Vault remains the HashiCorp secret system. |
| Vault integration | Templates and task auth to Vault through workload identity.                                                              | Strong secret story when the HashiCorp stack is present.                                       |
| Consul identity   | Service registration/mesh can obtain Consul tokens via workload identity.                                                | Strong service identity when Consul is present.                                                |
| Sentinel policies | Enterprise policy enforcement on job submission.                                                                         | Comparable to HoBo policy gates, but commercial/enterprise-bound.                              |

### Scheduling, rollout, and operations

- **Regions/datacenters/federation:** clusters can be region-aware; multi-region federation lets users submit jobs or interact with APIs from any attached region.
- **Node pools:** partition clients for workload classes/tenancy/placement.
- **Constraints/affinities/spread:** hard and soft placement, distribution across attributes, zones, racks, node metadata, class, kernel, cloud attributes, etc.
- **Resource-aware scheduling:** CPU/memory/device reservations, dynamic ports, CSI volumes, host volumes.
- **Rolling deployment controls:** canaries, health checks, auto-promote/auto-revert, max parallel, healthy deadline/progress deadline.
- **Resilience controls:** restart policies for tasks, reschedule policies for allocations, disconnect behavior for client loss, migration on node drain.
- **Batch/on-demand:** parameterized jobs and Nomad Autoscaler support on-demand client capacity for batch workloads.
- **Web UI / API / CLI:** job status, allocation logs/exec, deployment status, variables, nodes, namespaces, evaluations, event stream.

### Nomad Pack

Nomad Pack is Nomad's Helm-like packaging layer.

| Surface    | Feature                                                                                                  | Competitive note                                                |
| ---------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Pack       | Directory with metadata, templates, variables, README, optional outputs/dependencies.                    | Reusable deployment unit for Nomad jobspecs.                    |
| Templates  | HCL jobspec templates rendered with variables and helper functions.                                      | Simple and familiar to operators; not typed app APIs.           |
| Variables  | `--var` and `--var-file`; later files win on duplicate keys.                                             | Comparable to Helm values.                                      |
| Registries | Default community registry plus custom git-based registries via go-getter.                               | Distribution surface for reusable workloads.                    |
| Commands   | `list`, `info`, `render`, `plan`, `run`, `status`, `stop`, `destroy`, `registry add/list/update/delete`. | Covers discover → inspect → render → deploy → remove lifecycle. |
| Caching    | Local `.nomad/packs` cache of registries/packs/refs.                                                     | Useful offline/repeatability detail; refs can pin versions.     |
| CI         | Official setup action exists for GitHub Actions.                                                         | Makes packs automation-friendly.                                |

Example workflow:

```bash
nomad-pack registry add community github.com/hashicorp/nomad-pack-community-registry
nomad-pack list
nomad-pack info prometheus
nomad-pack render prometheus -f values.hcl
nomad-pack run prometheus -f values.hcl
nomad-pack status prometheus
nomad-pack destroy prometheus
```

## Architecture

- **Servers** — a Raft-replicated cluster holding state and running the scheduler; leader election
  and consensus are the availability model.
- **Clients** — agents on each node advertising fingerprinted resources and running allocations.
- **Scheduling** — an evaluation produces a plan: feasibility filtering by constraints, then ranking
  by affinities and bin-packing. This is genuinely a scored placement decision, made by the
  scheduler rather than declared by the user.
- **Federation** — multi-region and multi-datacenter with request forwarding.
- **State authority** — Raft-backed server state; allocations are the durable record of what runs
  where.
- **Portability boundary** — Nomad schedules onto its own clients. Jobs are portable across Nomad
  clusters and nowhere else; the driver abstraction covers workload shape, not provider.

## Where Nomad is stronger

> Shipped, evidenced capability only.


### Headline differentiators

1. **One scheduler for heterogeneous workloads** — containers, binaries, Java, QEMU, services, batch, system jobs, and parameterized dispatch.
2. **Operational simplicity vs Kubernetes** — small binary/agent model, HCL jobspecs, direct scheduler API, no Kubernetes resource sprawl.
3. **Mature placement/lifecycle controls** — constraints, affinities, spreads, canaries, health-gated deploys, reschedule/restart/migrate behavior, node drains.
4. **HashiCorp-stack integration** — Consul for discovery/mesh, Vault for secrets, Terraform/Packer ecosystem familiarity, HCL language, Sentinel policy in enterprise.
5. **Native workload identity direction** — task/service identities issue JWTs and drive Vault/Consul auth flows.
6. **Nomad Pack distribution** — reusable jobspec packaging with registries and render/plan/run workflow.
7. **Legacy + edge fit** — non-container workloads and simpler operational footprint are compelling for brownfield environments.

### How Nomad positions vs others

- **vs Kubernetes:** simpler scheduler and operations model; supports non-container workloads directly; fewer built-in platform APIs/ecosystem resources.
- **vs PaaS/serverless:** far more control over placement/runtime; much less app-level abstraction, auto-provisioned managed resources, or end-user developer sugar.
- **vs Helm:** Nomad Pack is similar in packaging spirit but targets Nomad jobspecs, not Kubernetes objects.
- **vs Nitric/Encore:** Nomad does not infer cloud resources from application code or generate least-privilege cloud IAM from SDK calls; it schedules declared workloads.
- **vs HoBo:** Nomad is a workload fabric; HoBo is designed as an AI-native meta-cloud with portable app/resource ports, event-sourced runtime semantics, resource matching, and agents as operators/principals.

## Gaps / limitations (opportunities for HoBo)

- **No Infrastructure-from-Code app SDK.** Nomad jobspecs are explicit HCL/JSON; resources are not collected from code like Nitric/HoBo.
- **No built-in cloud managed-resource abstraction.** Databases, buckets, queues, topics, AI, feature flags, etc. require separate products, templates, Terraform, or app-specific wiring.
- **No automatic least-privilege cloud IAM from app operations.** ACLs and workload identity are strong inside Nomad/HashiCorp integrations, but not equivalent to `.allow()` across cloud resources.
- **HashiCorp-stack gravity.** Best experience often assumes Consul, Vault, Terraform, Sentinel, and HCL fluency.
- **Packaging is templating, not typed contracts.** Nomad Pack lacks HoBo-style protobuf/CUE/PACT/WIT conformance gates or generated providers.
- **No event-sourced app runtime.** Nomad manages workload lifecycle, not application state as durable actors, sagas, reactive projections, replayable workflows, or materialized views.
- **No AI-native operator model.** It has APIs/CLI/UI, but no first-class autonomous SRE/GitOps/platform agents with scoped identities, policy gates, and replayable decisions.
- **No WASM Component Model contract.** Wasm can be run if packaged behind a driver/container, but Nomad does not make WIT interfaces the provider contract.
- **Multi-cloud means schedule-anywhere, not provider-portable app resources.** A Nomad job can run in many environments; its backing services are still environment-specific unless external tooling standardizes them.

## Primitive mapping

<a id="hobo-mapping"></a>

> For every Nomad/Nomad Pack feature, the HoBo equivalent and the design doc that owns it. ✅ = designed at parity · ➕ = HoBo goes further · ↔ = adjacent/composable · 🔜 = planned/iteration hook. HoBo design lives in [`../design/`](../design/index.md). The displacement decision — why self-hosted wasmCloud ([ADR-0031](../design/adr/01-architecture-core.md#adr-0031)) + Matching ([ADR-0033](../design/adr/01-architecture-core.md#adr-0033)) + Dispatcher ([ADR-0071](../design/adr/01-architecture-core.md#adr-0071)) subsume the scheduler pillar, and Nomad's accepted-future deploy-target disposition — is recorded in [ADR-0106](../design/adr/01-architecture-core.md#adr-0106). Rows with no committed design text anchor to an explicit iteration hook, never to a bare status.

### Core model

| Nomad / Nomad Pack              | HoBo equivalent                                                                                       | Status | HoBo doc                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Workload scheduler/orchestrator | Yard/Camp control plane + Planner + runtime adapters schedule Bindles/components to providers         | ✅     | [04](../design/control-plane.md#plan-04), [20](../design/wasm-runtime-wit.md#plan-20)                  |
| Jobspec HCL                     | `hobo.config.ts` + collected Manifest IR + resource graph                                             | ➕     | [02](../design/sdk-api.md#plan-02), [21](../design/authoring-resources-wiring.md#plan-21)              |
| Job/group/task hierarchy        | Yard → Camp/environment → Bindle/service/component; links express dependencies                        | ✅     | [20](../design/wasm-runtime-wit.md#plan-20), [21](../design/authoring-resources-wiring.md#plan-21)     |
| Allocation placement            | Matching selects runtime/resource providers per boundary and records decisions                        | ➕     | [25](../design/platform-engineering.md#plan-25), [04](../design/control-plane.md#plan-04)              |
| Nomad client drivers            | HoBo runtime providers: wasm component host by default, OCI/container/VM adapters as provider choices | ➕     | [20](../design/wasm-runtime-wit.md#plan-20), [04](../design/control-plane.md#plan-04)                  |
| Nomad Pack                      | Registry artifacts + Resource Definitions + generated/app templates                                   | ➕     | [21](../design/authoring-resources-wiring.md#plan-21), [25](../design/platform-engineering.md#plan-25) |

### Workload and resource catalog

| Nomad feature                | HoBo equivalent                                                                                                      | Status | HoBo doc                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| Service jobs                 | Long-running service components                                                                                      | ✅     | [20](../design/wasm-runtime-wit.md#plan-20)                                                         |
| Batch jobs                   | `hobo:job` / durable job resource                                                                                    | ✅     | [21](../design/authoring-resources-wiring.md#plan-21), [02](../design/sdk-api.md#plan-02)           |
| System jobs                  | Yard/operator/system Bindles per Camp/node class                                                                     | 🔜     | [iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks) |
| Periodic jobs                | `hobo:scheduler` + jobs/workflows                                                                                     | ✅     | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Parameterized/dispatch jobs  | Commands/events into actor/workflow/job ports                                                                        | ➕     | [02](../design/sdk-api.md#plan-02), [11](../design/data-plane.md#plan-11)                           |
| Docker workloads             | OCI fallback/provider adapter                                                                                        | ✅     | [20](../design/wasm-runtime-wit.md#plan-20), [04](../design/control-plane.md#plan-04)               |
| Raw exec / Java / QEMU       | Host/runtime adapters selected by Matching; OCI/VM adapters designed, raw-exec host adapter not yet designed         | ↔      | [04](../design/control-plane.md#plan-04), [iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks) |
| Dynamic ports/network blocks | `http`/network/domain/dns ports + provider-specific placement constraints                                            | ✅     | [21](../design/authoring-resources-wiring.md#plan-21), [12](../design/security-networking.md#plan-12) |
| CSI/host volumes             | Blob/data/storage providers; host/volume escape hatches                                                              | ↔      | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Nomad Variables/templates    | `config`/`secret` ports + typed parsed configuration                                                                 | ➕     | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Consul service discovery     | `service`/`http`/mesh provider; could target Consul                                                                  | ↔      | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Vault secrets                | `secret` provider adapter; could target Vault                                                                        | ↔      | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Autoscaler                   | HoBo reliability/cost policies + operator agents                                                                     | ➕     | [05](../design/reliability-observability-cost.md#plan-05), [40](../design/operators-sre.md#plan-40) |

### Operations, security, and rollout

| Nomad feature                     | HoBo equivalent                                                          | Status | HoBo doc                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| Constraints/affinities/spread     | Context-matching selects Resource Definitions; ADR-0108 covers substrate scheduler hints; the planner now ships a HoBo-native placement-criteria vocabulary (property selectors, affinity/anti-affinity, spread, pickN — `packages/cloud/src/planner/placement.ts`) | ✅     | [25](../design/platform-engineering.md#plan-25), [iteration hook](../design/platform-engineering.md#node-placement-and-system-workloads-iteration-hooks) |
| Rolling update/canary/auto-revert | Deployment events, progressive delivery gates, rollback/replay           | ✅     | [05](../design/reliability-observability-cost.md#plan-05), [11](../design/data-plane.md#plan-11)    |
| Service checks + drain lifecycle  | Endpoint Monitor/SRE operators + health projections + policy-gated drain | ➕     | [40](../design/operators-sre.md#plan-40), [05](../design/reliability-observability-cost.md#plan-05) |
| ACLs/namespaces                   | Project/Yard/Camp RBAC and policy                                        | ✅     | [12](../design/security-networking.md#plan-12)                                                      |
| Workload Identity JWTs            | Workload + agent identities, SVID-style principals, token broker         | ➕     | [06](../design/ai-native-agent-auth.md#plan-06)                                                     |
| Vault/Consul auth                 | Secret/service provider adapters behind ports                            | ↔      | [21](../design/authoring-resources-wiring.md#plan-21)                                               |
| Sentinel policy                   | Policy gates over manifests, deploys, agent actions, and conformance     | ✅     | [12](../design/security-networking.md#plan-12), [46](../design/governance-planes.md#plan-46)        |
| CLI/API/UI                        | `hobo` CLI, control-plane API, developer/fleet dashboard                 | ✅     | [07](../design/developer-experience.md#plan-07), [04](../design/control-plane.md#plan-04)           |

### Where HoBo deliberately exceeds Nomad

| Capability                                                                                                                                                                     | HoBo doc                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Infrastructure-from-Code authoring**: resources declared in app code and collected into Manifest IR, not hand-written jobspec-only deployment.                               | [02](../design/sdk-api.md#plan-02), [21](../design/authoring-resources-wiring.md#plan-21)               |
| **Portable app-resource ports**: databases, buckets, queues, topics, secrets, schedules, jobs, websockets, AI, websites, config, feature flags behind WIT/equivalence classes. | [21](../design/authoring-resources-wiring.md#plan-21), [20](../design/wasm-runtime-wit.md#plan-20)      |
| **WASM/WASI/WIT-first runtime contract**: providers export WIT interfaces; the membrane is wRPC/component links, not scheduler driver plugins plus ad hoc app protocols.       | [20](../design/wasm-runtime-wit.md#plan-20), [ADR-0069](../design/adr/01-architecture-core.md#adr-0069) |
| **Event-sourced application runtime**: actors, durable workflows, sagas, materialized projections, replay/time-travel/audit.                                                   | [02](../design/sdk-api.md#plan-02), [11](../design/data-plane.md#plan-11)                               |
| **Agents as first-class operators/principals**: SRE, Endpoint Monitor, GitOps, Platform Engineer, scoped credentials, MCP/API control, policy-gated changes.                   | [06](../design/ai-native-agent-auth.md#plan-06), [40](../design/operators-sre.md#plan-40)               |
| **Generated providers and implementations**: Forge/SWE loop can generate adapters, stubs, conformance tests, and implementation code.                                          | [23](../design/generated-stack.md#plan-23)                                                              |
| **Typed contract gates**: Protobuf/CUE/PACT/WIT conformance for boundaries and resources, beyond HCL template rendering.                                                       | [09](../design/generated-stack.md#plan-09), [21](../design/authoring-resources-wiring.md#plan-21)       |

### Where Nomad is ahead / pressure on HoBo

- **Battle-tested general scheduler.** Nomad's placement, allocation lifecycle, node drain, canary/update, and mixed-workload support are deep and production-proven.
- **Legacy workload reach.** Raw binaries, Java, QEMU, and driver plugins give Nomad a broad brownfield path HoBo must intentionally preserve through OCI/VM/host adapters.
- **Operational simplicity.** HoBo's broader meta-cloud model risks more moving parts; Nomad's small-binary scheduler story is a high bar for self-hosted operations.
- **Consul/Vault integration depth.** HoBo can target those as providers, but Nomad's native integration is a strong default for HashiCorp shops.
- **Nomad Pack ecosystem.** HoBo's Registry must be as easy as `nomad-pack run`, while adding stronger typing/proofs without making simple deployments feel heavy.

## Sources

- HashiCorp Developer — Nomad overview: <https://developer.hashicorp.com/nomad>
- HashiCorp Developer — Nomad documentation and job specification: <https://developer.hashicorp.com/nomad/docs>
- HashiCorp Developer — `group` and `service` jobspec blocks: <https://developer.hashicorp.com/nomad/docs/job-specification/group>, <https://developer.hashicorp.com/nomad/docs/job-specification/service>
- HashiCorp Developer — Nomad Variables and workload identity release/upgrade notes: <https://developer.hashicorp.com/nomad/docs/concepts/variables>, <https://developer.hashicorp.com/nomad/docs/release-notes/v1-10-x>
- HashiCorp Developer — Nomad Pack command docs: <https://developer.hashicorp.com/nomad/tools/nomad-pack/commands/registry/add>
- GitHub — `hashicorp/nomad-pack`: <https://github.com/hashicorp/nomad-pack>

## Adversarial critique

- **Ecosystem gravity went to Kubernetes.** Nomad is widely agreed to be simpler and better
  operationally for many estates, and lost the ecosystem battle regardless. Tooling, hiring and
  third-party integration all reflect that.
- **Licensing changed.** HashiCorp's move from MPL to the Business Source License in 2023 altered
  the open-source proposition for the whole product family, and OpenTofu's existence shows how
  seriously the ecosystem took it. This is a strategic risk for anyone standing on it.
- **The IBM acquisition adds stewardship uncertainty** that adopters should weigh, independent of the
  technology.
- **Scheduling is not a platform.** Nomad places workloads; service discovery, secrets, mesh and CI
  are Consul, Vault and other products — the suite is the answer, and the suite is the coupling.
- **Jobspec is operational, not application-level.** It describes how to run a thing, not what an
  application needs, so it sits below the abstraction HoBo is arguing for.
- **Raft cluster operations** — quorum, snapshots, upgrades — are real work, smaller than Kubernetes'
  and not nothing.

## Where HoBo is stronger or intentionally different

- **HoBo matches capabilities to providers; Nomad matches workloads to nodes** (*implemented*). Both
  are scored placement, at different altitudes — Nomad's decides *which machine*, HoBo's decides
  *which cloud service or host*.
- **The decision is recorded and replayable** (*implemented*, `match.Decided` on an event log);
  Nomad's evaluation produces an allocation, not an explanation.
- **Not tied to one scheduler's clients** (*implemented*): HoBo targets provider services, wasm
  hosts, or local runtimes, and a Nomad cluster could be one of them.
- **Fail-closed residency** (*implemented*, ADR-0146); Nomad's datacenter constraints are placement
  hints without a jurisdiction model.
- **Honest caveat.** Nomad's scheduler is production-proven at very large scale; HoBo's matching is
  implemented but has not been exercised anywhere near that hard.

## Better-together / integration posture

- **Borrow** — recorded in [`lineage.md`](../design/lineage.md): heterogeneous scheduling and
  federation intent. Worth adding explicitly — **constraint / affinity / spread as a declarative
  placement vocabulary** is a well-designed language for expressing placement preferences, and HoBo's
  matching inputs would benefit from being that legible.
- **Provider-target** — a Nomad cluster is a plausible Camp substrate.
- **Benchmark** on scheduler behaviour under bin-packing pressure and on multi-region federation.
- Not an adopt or displace target.

## Threats and lessons

1. **Being better is not sufficient.** Nomad's operational simplicity was real and Kubernetes won on
   ecosystem. The lesson for HoBo is that architectural advantage must be paired with an adoption
   path, not assumed to speak for itself.
2. **Licence changes are an ecosystem-level risk.** The BSL move is exactly why HoBo's adapter model
   keeps no engine primary (ADR-0006), and why an open core matters to buyers who have lived through
   one.
3. **Placement vocabulary is worth stealing.** Constraints, affinities and spread give users a way to
   express intent about placement that HoBo's scoring inputs currently lack.
4. **Scheduling alone is not a platform** — the suite requirement is what made Nomad harder to adopt
   than its core suggested.

## Sources

- [Nomad documentation](https://developer.hashicorp.com/nomad/docs) — jobspec, task drivers, scheduling, constraints, federation, Nomad Pack
- [hashicorp/nomad](https://github.com/hashicorp/nomad) — source and current licence
- HoBo-side: [`design/lineage.md`](../design/lineage.md) records Nomad as a pivoted pillar

This capture predates the research contract and was restructured to it on 2026-08-20 with its
original research preserved. Current licence terms and post-acquisition roadmap were not
re-verified in this pass and are not asserted.
