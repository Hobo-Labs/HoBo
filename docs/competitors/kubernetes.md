---
type: Competitive Reference
title: "Kubernetes — Competitor Reference"
description: "The container orchestrator that became the industry's substrate: declarative objects, controller reconciliation, and CRDs as the extension model everything else builds on."
tags: [hobo, competitors]
competitor:
  slug: kubernetes
  name: "Kubernetes"
  aliases: ["k8s"]
  primary_category: runtime-substrates
  categories: [runtime-substrates, portable-application-models, hybrid-multicloud-enterprise]
  directness: adjacent
  role: "the default substrate almost every competitor assumes — a target HoBo supports and a premise HoBo declines"
  posture: [adopt, provider-target, borrow, standard]
  hobo_surface: [reconciliation, runtime-portability, provider-matching, extensibility, governance]
  evidence: mixed
  status: active
  research_date: 2026-08-20
  contract: v1
  sources:
    - https://kubernetes.io/docs/concepts/
    - https://kubernetes.io/docs/concepts/architecture/controller/
    - https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/
    - https://github.com/kubernetes/kubernetes
---

# Kubernetes — Competitor Reference

> Captured for HoBo competitive analysis under the HoBo Competitive Research Contract.
> Research date **2026-08-20**.
>
> **Why this capture exists.** Kubernetes is not a competitor in the ordinary sense; it is the
> *premise* almost every other capture in this corpus rests on. Crossplane, KubeVela, OpenChoreo,
> Radius, Kratix, Qovery, Porter, Northflank and Red Hat Developer Hub all require it. HoBo's most
> load-bearing architectural decision — that Kubernetes is one substrate rather than the floor —
> only makes sense against a clear-eyed account of what Kubernetes actually is and does well.

## What it is

Kubernetes is an **open-source container orchestration system** (CNCF, Apache-2.0) that has become
the de-facto standard substrate for server-side computing. Its lasting contribution is not container
scheduling but a *pattern*: declarative desired state held in an API server, reconciled continuously
by controllers, extended by adding new object types.

- **Product boundary.** Cluster-level orchestration: scheduling, networking, storage attachment,
  service discovery, and an extensible API. It is not a PaaS and does not pretend to be.
- **Operating model.** Self-hosted or managed (EKS, GKE, AKS and dozens more).
- **Governance.** CNCF, multi-vendor, with a release cadence and support window that are themselves
  a significant operational constraint.

## Core primitives and mental model

| Primitive | What it is |
| --------- | ---------- |
| **API server** | The single front door; every object is created, read and watched through it |
| **etcd** | The consistent store holding all cluster state |
| **Object / resource** | Declarative desired state: Pod, Deployment, Service, ConfigMap, and so on |
| **Controller** | A loop that observes actual state and acts to converge it toward desired state |
| **Scheduler** | The controller that assigns Pods to Nodes by fit and priority |
| **CRD** | A Custom Resource Definition — a new object type, first-class in the API |
| **Operator** | A CRD plus a controller encoding operational knowledge for a specific system |
| **Namespace / RBAC** | The tenancy and authorization boundaries |

The mental model is **level-triggered reconciliation over declarative objects**. You never tell
Kubernetes to *do* something; you record what should be true, and controllers work continuously to
make it so. That single idea — with CRDs making it extensible to anything, not just containers — is
why the ecosystem is what it is, and it is the idea HoBo borrows most directly.

## Feature surface

- **Workload types** — Deployment, StatefulSet, DaemonSet, Job, CronJob.
- **Scheduling** — resource requests and limits, node selectors, affinity/anti-affinity, taints and
  tolerations, topology spread, priority and preemption.
- **Networking** — Services, Ingress and Gateway API, NetworkPolicy, a pluggable CNI.
- **Storage** — PersistentVolumes, StorageClasses and CSI drivers.
- **Configuration** — ConfigMaps and Secrets (base64-encoded, not encrypted, without additional
  configuration).
- **Extensibility** — CRDs, operators, admission webhooks, custom schedulers, device plugins.
- **Governance** — RBAC, admission control, Pod Security Standards, quotas.
- **Autoscaling** — horizontal, vertical, and cluster-level.

## Architecture

- **Control plane** — API server, etcd, scheduler, controller manager, cloud controller manager.
- **Data plane** — nodes running kubelet and a container runtime, with a CNI plugin for networking.
- **Reconciliation** — every controller watches the API server and converges its slice of the world;
  the whole system is many small loops rather than one orchestrator.
- **State authority** — etcd, holding desired state and observed status. Object count and size are
  the practical scaling wall, which is why CRD-heavy systems hit limits before workload-heavy ones.
- **Extension model** — a CRD makes a new type first-class in the API, inheriting RBAC, watch, audit
  and every client tool for free. This is the property that made Kubernetes an application platform
  rather than a container scheduler.
- **Portability boundary** — genuinely real and frequently overstated. A Deployment is portable
  across conformant clusters; the Ingress controller, storage classes, load balancer behaviour,
  node characteristics and every operator underneath are not. "Runs on Kubernetes" means the
  workload moves and its environment does not.

## How it competes with HoBo

Kubernetes and HoBo **do not compete for the same job**, and the interesting question is the
architectural relationship rather than a feature contest.

| Contested HoBo surface | The relationship |
| ---------------------- | ---------------- |
| `reconciliation` | **Borrowed.** HoBo's reconcile model descends from this pattern, via Crossplane |
| `runtime-portability` | Kubernetes offers cluster-level portability; HoBo offers provider-level portability, which is a strictly larger claim requiring impedance reporting |
| `provider-matching` | The scheduler's fit-and-rank is a scored placement decision — at the node level, where HoBo's is at the provider level |
| `extensibility` | CRDs are the extension model HoBo's kinds and adapters are measured against |
| `governance` | RBAC and admission control are the enforcement precedent HoBo's policy gates follow |

**The decision that defines HoBo.** Every competitor in this corpus that assumes Kubernetes gets an
enormous amount for free and inherits a floor: a cluster must exist, be paid for, and be operated
before anything runs. HoBo declines that premise — local, browser and hosted runtimes, with
Kubernetes as one target. That choice costs HoBo the ecosystem and buys the segment Kubernetes
cannot serve.

## Primitive mapping

| Kubernetes | Nearest HoBo concept | Honest correspondence |
| ---------- | -------------------- | --------------------- |
| Controller reconciliation | HoBo reconcile loop | **Direct descent**, acknowledged in [`lineage.md`](../design/lineage.md) via Crossplane. |
| Object / desired state | Manifest IR | Close in spirit; HoBo's authority is an event log rather than etcd's current-state store. |
| **CRD** | Bindle kind | **The closest analog, and instructive.** A CRD adds a type to an API; a Bindle kind adds a capability contract with declared impedance. CRDs inherit tooling; HoBo's kinds inherit portability scoring. |
| Operator | Provider adapter | Close: both encode how to realize and operate a specific system. |
| Scheduler (fit + rank) | Provider matching | **Structurally the same algorithm at a different altitude.** Filter feasible candidates, rank them, record the assignment. HoBo additionally records *why* as an event. |
| Namespace + RBAC | Tenant + policy | Partial; HoBo's policy decisions are events. |
| Admission webhook | Policy gate | **Close, and Kubernetes' is the precedent.** Both intercept before persistence. |
| Service / Ingress / Gateway | Connectivity and gateway ports | Partial. |
| etcd | EventStore | **Different in kind.** etcd holds current state; HoBo's log holds history and replays. |
| — | `PortabilityReport` | **No equivalent.** Kubernetes portability is asserted by conformance, not scored per workload. |

## Where Kubernetes is stronger

- **The ecosystem, which is not a feature but is decisive.** Every vendor integrates with it, every
  cloud offers it managed, every engineer can be hired for it, and every problem has been hit before
  by someone who wrote it down.
- **The reconciliation pattern is genuinely excellent** and has proven itself far beyond containers.
- **CRDs made the API extensible without forking anything**, which is the single best extensibility
  decision in this corpus.
- **Operational maturity at extreme scale**, across a decade, with a multi-vendor governance model
  that has survived commercial pressure.
- **Admission control and RBAC** are a proven enforcement architecture.
- **Managed offerings** mean the control plane is somebody else's problem for most adopters.

## Where HoBo is stronger or intentionally different

State labels follow the research contract: **implemented** = shipped in `packages/`.

- **No cluster required** (*implemented*). `@hobo/runtime-local` and `@hobo/runtime-browser` mean the
  model runs with no infrastructure at all. This addresses the entire segment below Kubernetes'
  operational floor, and it is HoBo's clearest structural advantage.
- **Portability across providers, not just clusters** (*implemented*, with coverage caveats in the
  [live provider matrix](../design/live-provider-matrix.md)). A Bindle can target a managed cloud
  service, a wasm host, or a cluster.
- **Portability is scored** (*implemented*, ADR-0144). Kubernetes conformance says an API exists,
  not that behaviour is equivalent — the gap where portability claims actually fail.
- **Event-sourced authority with replay** (*implemented*, ADR-0135) versus etcd's current state.
- **Fail-closed residency** (*implemented*, ADR-0146); topology spread constraints are not a
  jurisdiction model.
- **Application-level intent** (*implemented*). Kubernetes objects describe runtime mechanics; a
  Bindle describes what the application needs.
- **Honest caveat.** Kubernetes is the most operationally proven system in this corpus by a wide
  margin, and HoBo runs on it as one target. Nothing here is a claim to have replaced it.

## Adversarial critique

- **The operational floor excludes an entire market.** A cluster must exist, be upgraded, be secured
  and be paid for before the first workload runs. Managed control planes reduce this and do not
  remove node management, upgrades, or the standing cost.
- **etcd is the scaling wall, and it arrives early for extension-heavy systems.** Object count and
  size, watch load and compaction behaviour bound the cluster well before compute does — which is
  precisely why CRD-heavy platforms (Crossplane at scale) hit limits.
- **Complexity is not accidental, it is inherent and cumulative.** Networking (CNI, Services,
  Ingress, Gateway API, NetworkPolicy), storage (CSI, StorageClasses, volume modes) and security
  (RBAC, admission, Pod Security, service accounts) are each a specialist domain, and production
  requires all of them.
- **The upgrade treadmill is relentless.** Three releases a year with a bounded support window means
  a cluster is never finished, and API deprecations propagate to every operator and CRD.
- **Secrets are base64, not encrypted, by default.** A recurring, avoidable source of incidents and
  an example of a default that has outlived its justification.
- **Portability is weaker than the marketing.** Conformance guarantees API shape, not behaviour;
  moving between managed offerings reliably surfaces differences in load balancers, storage classes,
  IAM integration and node images.
- **Multi-tenancy is hard.** Namespaces are a soft boundary; genuine hostile multi-tenancy requires
  virtual clusters or separate clusters, which returns the cost.
- **The abstraction leaks upward through everything built on it.** Every product in this corpus that
  assumes Kubernetes inherits all of the above, and passes it to its customers under a friendlier
  name.

## Better-together / integration posture

- **Adopt / provider-target** — Kubernetes is a first-class HoBo target, and the wasmCloud lattice,
  SpinKube and ordinary containers all run on it.
- **Borrow** — recorded and reaffirmed: **level-triggered reconciliation** (via Crossplane) and
  **admission control as an enforcement point**. Worth adding: **CRDs as the extensibility lesson** —
  making a new type first-class in the existing API, so it inherits every tool, is why the ecosystem
  compounded.
- **Standard** — Kubernetes object shapes are spoken at the boundary when rendering, never absorbed
  as HoBo's internal model, per the governing rule in [`lineage.md`](../design/lineage.md).
- **Not a displace target**, and any HoBo material implying otherwise would be wrong. The claim is
  narrower and more defensible: *Kubernetes is one substrate, not the premise*.

## Threats and lessons

1. **Assuming Kubernetes is the single most common architectural decision in this corpus**, and it is
   why so many competitors look alike. HoBo's refusal is its main structural differentiator and its
   main adoption cost — that trade should be stated openly rather than presented as pure upside.
2. **CRDs are the extensibility bar.** Adding a type that inherits all existing tooling is why the
   ecosystem compounded. If adding a Bindle kind is harder than writing a CRD, HoBo's extensibility
   story loses.
3. **Conformance is not portability**, and Kubernetes is the industry's largest demonstration of the
   gap. That gap is the exact thing `PortabilityReport` exists to measure, and this is the most
   persuasive example available for explaining why it matters.
4. **The scheduler is the closest thing to HoBo's matching that has run at scale** — filter, rank,
   assign. Its production behaviour under bin-packing pressure and preemption is the best available
   evidence for how HoBo's matching will behave, and worth studying rather than reinventing.
5. **Operational floor is market segmentation.** Everything below it — small teams, local
   development, edge, browser — is a segment Kubernetes structurally cannot serve, and it is HoBo's
   natural entry point.

## Sources

- [Kubernetes concepts](https://kubernetes.io/docs/concepts/) — objects, workloads, networking, storage, configuration
- [Controllers](https://kubernetes.io/docs/concepts/architecture/controller/) — the reconciliation pattern
- [Custom resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/) — CRDs and the extension model
- [kubernetes/kubernetes](https://github.com/kubernetes/kubernetes) — source, Apache-2.0, CNCF governance
- HoBo-side: [`design/lineage.md`](../design/lineage.md), ADR-0006, ADR-0031, [live provider matrix](../design/live-provider-matrix.md)

Specific etcd scaling limits, current release-support windows and managed-offering differences vary
by version and vendor; none is asserted with a number here.
