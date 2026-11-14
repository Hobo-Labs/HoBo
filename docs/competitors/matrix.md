---
type: Competitive Reference
title: "Cross-category competitor matrix"
description: "Generated cross-category matrix and freshness ledger for the HoBo competitor corpus."
tags: [hobo, competitors, matrix]
---

# Cross-category competitor matrix

> **Generated.** The table below is derived from the `competitor:` front matter of every canonical
> capture under [`docs/competitors/`](index.md). Do not hand-edit between the generated markers —
> change the capture's front matter and run `pnpm run docs:competitors:fix`.
> The schema is defined in [`metadata-contract.md`](metadata-contract.md); category views live in
> [`categories/`](categories/index.md).

## How to read it

- **Directness** — `direct` (substitutes HoBo), `overlapping` (contests some surfaces),
  `adjacent` (informs HoBo, may compose), `complementary` (fronts or plugs into HoBo).
- **Posture** — what HoBo should *do* about it, not what it is.
- **HoBo evidence** — HoBo's own state on the contested surfaces: `implemented`, `proof`,
  `design-only`, `not-present`, or `mixed`. This column is the honesty control: a row may never
  imply parity that `packages/` does not have.
- **Contract** — `v1` once the capture has been rewritten to the twelve-section research contract.
  `pre-v1` captures are real, source-backed research that predate the contract and are queued for
  rewrite by their own research issue; their `mixed` evidence marker is deliberately coarse until then.

<!-- BEGIN GENERATED: competitor-matrix -->

| Competitor | Canonical doc | Aliases | Primary category | All categories | Directness | Contested HoBo surfaces | Posture | HoBo evidence | Product status | Researched | Contract |
| ---------- | ------------- | ------- | ---------------- | -------------- | ---------- | ----------------------- | ------- | ------------- | -------------- | ---------- | -------- |
| **Alchemy** | [`alchemy.md`](alchemy.md) | — | `infrastructure-from-code` | `infrastructure-from-code` · `portable-application-models` | direct | authoring, typed-contracts, reconciliation, extensibility | borrow, benchmark | mixed | active | 2026-11-08 | v1 |
| **Anonymous container hosts** | [`anon-container-hosts.md`](anon-container-hosts.md) | openpouch, clawdship, ttl.sh, zerodeploy, dockup | `cloud-application-platforms` | `cloud-application-platforms` · `self-hosted-paas` | adjacent | provider-matching, delivery | benchmark, provider-target | mixed | active | 2026-08-20 | v1 |
| **Antimetal** | [`antimetal.md`](antimetal.md) | — | `agentic-infrastructure` | `agentic-infrastructure` · `finops-governance-placement` | adjacent | observability, agent-surface, finops | benchmark, integrate | mixed | active | 2026-08-20 | v1 |
| **Appvia Wayfinder** | [`appvia-wayfinder.md`](appvia-wayfinder.md) | wayfinder, appvia | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `platform-orchestrators` · `developer-portals-idps` | overlapping | environments, governance, provider-matching, identity-secrets, app-graph | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Argo CD** | [`argo-cd.md`](argo-cd.md) | argocd, applicationset | `delivery-release-gitops` | `delivery-release-gitops` · `platform-orchestrators` | overlapping | reconciliation, delivery, environments, governance, app-graph | borrow, benchmark, integrate, render-target | mixed | active | 2026-08-20 | pre-v1 |
| **.NET Aspire** | [`aspire.md`](aspire.md) | dotnet aspire | `infrastructure-from-code` | `infrastructure-from-code` · `portable-application-models` · `runtime-substrates` | direct | authoring, app-graph, wiring, environments | borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Atlassian Compass** | [`atlassian-compass.md`](atlassian-compass.md) | compass | `developer-portals-idps` | `developer-portals-idps` | complementary | app-graph, governance | integrate, benchmark | mixed | active | 2026-08-20 | v1 |
| **AWS Amplify** | [`aws-amplify.md`](aws-amplify.md) | amplify gen 2 | `infrastructure-from-code` | `infrastructure-from-code` · `backend-data-platforms` · `cloud-application-platforms` | overlapping | authoring, typed-contracts, wiring | benchmark | mixed | active | 2026-08-19 | v1 |
| **Backstage** | [`backstage.md`](backstage.md) | spotify backstage | `developer-portals-idps` | `developer-portals-idps` | complementary | governance, ecosystem, extensibility | integrate, borrow | mixed | active | 2026-08-19 | v1 |
| **CapRover** | [`caprover.md`](caprover.md) | captainduckduck | `self-hosted-paas` | `self-hosted-paas` | adjacent | delivery, environments, extensibility | benchmark | mixed | active | 2026-08-20 | v1 |
| **CAST AI** | [`cast-ai.md`](cast-ai.md) | cast.ai, castai | `finops-governance-placement` | `finops-governance-placement` · `platform-orchestrators` | adjacent | finops, provider-matching, reconciliation, governance | benchmark, borrow, integrate | mixed | active | 2026-08-20 | pre-v1 |
| **celld** | [`celld.md`](celld.md) | — | `runtime-substrates` | `runtime-substrates` | adjacent | runtime-portability, reconciliation | adopt, provider-target | mixed | active | 2026-08-20 | v1 |
| **CloudBolt** | [`cloudbolt.md`](cloudbolt.md) | cloudbolt software | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `finops-governance-placement` · `platform-orchestrators` | overlapping | provider-matching, governance, finops, environments | benchmark | mixed | active | 2026-08-20 | v1 |
| **Cloudify** | [`cloudify.md`](cloudify.md) | cloudify orchestrator | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `portable-application-models` | overlapping | app-graph, typed-contracts, wiring, provider-matching, extensibility | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Control Plane** | [`control-plane.md`](control-plane.md) | controlplane.com, cpln | `platform-orchestrators` | `platform-orchestrators` · `cloud-application-platforms` · `hybrid-multicloud-enterprise` · `runtime-substrates` · `identity-networking-delivery` · `agentic-infrastructure` | direct | runtime-portability, provider-matching, environments, identity-secrets, app-graph | displace, benchmark, borrow, provider-target | mixed | active | 2026-08-19 | v1 |
| **Convex** | [`convex.md`](convex.md) | — | `backend-data-platforms` | `backend-data-platforms` | adjacent | typed-contracts, wiring, runtime-portability | borrow, provider-target | mixed | active | 2026-08-20 | v1 |
| **Coolify** | [`coolify.md`](coolify.md) | coolify.io | `self-hosted-paas` | `self-hosted-paas` · `cloud-application-platforms` | overlapping | authoring, delivery, environments, provider-matching | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Cortex** | [`cortex.md`](cortex.md) | cortex.io | `developer-portals-idps` | `developer-portals-idps` · `agentic-infrastructure` | complementary | app-graph, governance, observability | integrate, benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Crossplane** | [`crossplane.md`](crossplane.md) | — | `portable-application-models` | `portable-application-models` · `platform-orchestrators` · `hybrid-multicloud-enterprise` | overlapping | typed-contracts, provider-matching, reconciliation, extensibility | borrow, integrate | mixed | active | 2026-08-19 | v1 |
| **Cycloid** | [`cycloid.md`](cycloid.md) | cycloid.io | `platform-orchestrators` | `platform-orchestrators` · `developer-portals-idps` · `finops-governance-placement` · `hybrid-multicloud-enterprise` | overlapping | authoring, environments, finops, observability, governance, app-graph | benchmark, borrow, integrate | mixed | active | 2026-08-19 | v1 |
| **Dapr** | [`dapr.md`](dapr.md) | — | `runtime-substrates` | `runtime-substrates` · `portable-application-models` | overlapping | typed-contracts, runtime-portability, wiring, identity-secrets | borrow, standard, integrate | mixed | active | 2026-08-19 | v1 |
| **Dokku** | [`dokku.md`](dokku.md) | dokku.com | `self-hosted-paas` | `self-hosted-paas` | adjacent | authoring, delivery, extensibility | benchmark | mixed | active | 2026-08-20 | v1 |
| **Dokploy** | [`dokploy.md`](dokploy.md) | dokploy.com | `self-hosted-paas` | `self-hosted-paas` | adjacent | delivery, environments | benchmark | mixed | active | 2026-08-20 | v1 |
| **DuploCloud** | [`duplocloud.md`](duplocloud.md) | duplo cloud | `platform-orchestrators` | `platform-orchestrators` · `hybrid-multicloud-enterprise` · `finops-governance-placement` | overlapping | governance, provider-matching, environments, identity-secrets, observability | benchmark, borrow, displace | mixed | active | 2026-08-19 | v1 |
| **Encore** | [`encore.md`](encore.md) | — | `infrastructure-from-code` | `infrastructure-from-code` · `cloud-application-platforms` | direct | authoring, app-graph, wiring, environments, delivery | displace, benchmark | mixed | active | 2026-08-19 | v1 |
| **Facets.cloud** | [`facets.md`](facets.md) | facets cloud | `platform-orchestrators` | `platform-orchestrators` · `portable-application-models` · `hybrid-multicloud-enterprise` · `finops-governance-placement` | direct | app-graph, environments, provider-matching, governance, extensibility | displace, benchmark, borrow | mixed | active | 2026-08-19 | v1 |
| **FinOps tooling cohort** | [`finops-tooling.md`](finops-tooling.md) | kubecost cohort | `finops-governance-placement` | `finops-governance-placement` | adjacent | finops, governance, provider-matching | benchmark, integrate | mixed | archived | 2026-08-20 | pre-v1 |
| **Flux CD** | [`flux-cd.md`](flux-cd.md) | fluxcd, flux2, gitops toolkit, flux v2 | `delivery-release-gitops` | `delivery-release-gitops` · `platform-orchestrators` | overlapping | reconciliation, delivery, governance, identity-secrets, environments | borrow, benchmark, integrate, render-target | mixed | active | 2026-08-20 | pre-v1 |
| **Flux Network** | [`flux-network.md`](flux-network.md) | flux, orbit, runonflux | `cloud-application-platforms` | `cloud-application-platforms` · `runtime-substrates` | adjacent | provider-matching, runtime-portability | provider-target | mixed | active | 2026-08-20 | v1 |
| **Fly.io** | [`flyio.md`](flyio.md) | fly | `cloud-application-platforms` | `cloud-application-platforms` | overlapping | environments, runtime-portability, delivery | provider-target, benchmark | mixed | active | 2026-08-19 | v1 |
| **Harness Platform** | [`harness.md`](harness.md) | harness.io, harness delegate | `platform-orchestrators` | `platform-orchestrators` · `delivery-release-gitops` · `developer-portals-idps` · `finops-governance-placement` · `agentic-infrastructure` | overlapping | delivery, governance, environments, finops, extensibility, observability | benchmark, borrow, integrate | mixed | active | 2026-08-19 | v1 |
| **Heroku** | [`heroku.md`](heroku.md) | — | `cloud-application-platforms` | `cloud-application-platforms` | overlapping | authoring, environments, delivery, ecosystem | benchmark | mixed | active | 2026-08-19 | v1 |
| **HPE Morpheus** | [`hpe-morpheus.md`](hpe-morpheus.md) | morpheus data, morpheus cmp | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `platform-orchestrators` · `finops-governance-placement` | overlapping | provider-matching, environments, governance, finops, delivery | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Humanitec** | [`humanitec.md`](humanitec.md) | — | `platform-orchestrators` | `platform-orchestrators` · `portable-application-models` | direct | app-graph, environments, provider-matching, governance | displace, benchmark | mixed | active | 2026-08-19 | v1 |
| **Infracost** | [`infracost.md`](infracost.md) | — | `finops-governance-placement` | `finops-governance-placement` · `infrastructure-from-code` | overlapping | finops, governance, delivery | borrow, benchmark, integrate | mixed | active | 2026-08-20 | pre-v1 |
| **InsForge** | [`insforge.md`](insforge.md) | — | `backend-data-platforms` | `backend-data-platforms` · `agentic-infrastructure` | adjacent | agent-surface, typed-contracts | benchmark, provider-target | mixed | active | 2026-08-20 | v1 |
| **Kamal** | [`kamal.md`](kamal.md) | mrsk, kamal deploy | `self-hosted-paas` | `self-hosted-paas` · `delivery-release-gitops` | adjacent | delivery, runtime-portability | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Kargo** | [`kargo.md`](kargo.md) | akuity-kargo | `delivery-release-gitops` | `delivery-release-gitops` | overlapping | delivery, environments, reconciliation | borrow, benchmark | implemented | active | 2026-11-11 | pre-v1 |
| **Karmada** | [`karmada.md`](karmada.md) | kubernetes-armada | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `delivery-release-gitops` | overlapping | provider-matching, delivery, reconciliation, environments | borrow, integrate, benchmark | implemented | active | 2026-11-11 | pre-v1 |
| **Kratix** | [`kratix.md`](kratix.md) | syntasso kratix, ske | `portable-application-models` | `portable-application-models` · `platform-orchestrators` · `delivery-release-gitops` | overlapping | typed-contracts, extensibility, provider-matching, delivery, app-graph | borrow, benchmark, integrate | mixed | active | 2026-08-19 | v1 |
| **Kubecost** | [`kubecost.md`](kubecost.md) | — | `finops-governance-placement` | `finops-governance-placement` | adjacent | finops, governance, observability | benchmark, integrate, borrow | mixed | active | 2026-08-20 | pre-v1 |
| **Kubernetes** | [`kubernetes.md`](kubernetes.md) | k8s | `runtime-substrates` | `runtime-substrates` · `portable-application-models` · `hybrid-multicloud-enterprise` | adjacent | reconciliation, runtime-portability, provider-matching, extensibility, governance | adopt, provider-target, borrow, standard | mixed | active | 2026-08-20 | v1 |
| **KubeVela** | [`kubevela.md`](kubevela.md) | vela | `portable-application-models` | `portable-application-models` · `platform-orchestrators` · `delivery-release-gitops` | overlapping | app-graph, typed-contracts, extensibility, delivery, environments | borrow, standard, render-target, benchmark | mixed | active | 2026-08-19 | v1 |
| **KusionStack** | [`kusionstack.md`](kusionstack.md) | kusion, kcl | `portable-application-models` | `portable-application-models` · `platform-orchestrators` · `infrastructure-from-code` | direct | authoring, typed-contracts, app-graph, provider-matching, environments, extensibility | displace, borrow, benchmark | mixed | active | 2026-08-19 | v1 |
| **Lagoon** | [`lagoon.md`](lagoon.md) | uselagoon, amazee.io lagoon | `cloud-application-platforms` | `cloud-application-platforms` · `self-hosted-paas` · `delivery-release-gitops` | adjacent | authoring, environments, delivery, runtime-portability | benchmark, borrow | mixed | active | 2026-08-19 | v1 |
| **Lakebed** | [`lakebed.md`](lakebed.md) | — | `cloud-application-platforms` | `cloud-application-platforms` · `agentic-infrastructure` | direct | agent-surface, authoring, delivery | displace | mixed | active | 2026-08-20 | v1 |
| **Massdriver** | [`massdriver.md`](massdriver.md) | massdriver.cloud | `platform-orchestrators` | `platform-orchestrators` · `portable-application-models` · `hybrid-multicloud-enterprise` · `developer-portals-idps` | direct | typed-contracts, wiring, app-graph, environments, extensibility, governance | displace, borrow, benchmark | mixed | active | 2026-08-19 | v1 |
| **Mia-Platform** | [`mia-platform.md`](mia-platform.md) | mia platform, miaplatform | `platform-orchestrators` | `platform-orchestrators` · `developer-portals-idps` · `hybrid-multicloud-enterprise` | direct | app-graph, environments, governance, agent-surface, extensibility, delivery | displace, benchmark, borrow | mixed | active | 2026-08-19 | v1 |
| **Modal** | [`modal.md`](modal.md) | — | `cloud-application-platforms` | `cloud-application-platforms` · `runtime-substrates` | adjacent | runtime-portability, provider-matching | provider-target, benchmark | mixed | active | 2026-08-19 | v1 |
| **NetBird** | [`netbird.md`](netbird.md) | net bird | `identity-networking-delivery` | `identity-networking-delivery` | complementary | identity-secrets, runtime-portability, governance | adopt, provider-target, borrow | mixed | active | 2026-08-20 | pre-v1 |
| **Netlify** | [`netlify.md`](netlify.md) | — | `cloud-application-platforms` | `cloud-application-platforms` | overlapping | delivery, environments | benchmark, provider-target | mixed | active | 2026-08-19 | v1 |
| **NetScaler** | [`netscaler.md`](netscaler.md) | citrix adc, netscaler adc | `identity-networking-delivery` | `identity-networking-delivery` | complementary | governance, identity-secrets | provider-target, borrow | mixed | active | 2026-08-20 | v1 |
| **Nitric** | [`nitric.md`](nitric.md) | nitrictech | `infrastructure-from-code` | `infrastructure-from-code` · `portable-application-models` | overlapping | authoring, typed-contracts, provider-matching, runtime-portability | borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Nomad** | [`nomad.md`](nomad.md) | nomad pack, hashicorp nomad | `runtime-substrates` | `runtime-substrates` · `platform-orchestrators` | overlapping | provider-matching, runtime-portability, reconciliation | borrow, provider-target, benchmark | mixed | active | 2026-08-20 | v1 |
| **Northflank** | [`northflank.md`](northflank.md) | — | `cloud-application-platforms` | `cloud-application-platforms` · `self-hosted-paas` | overlapping | environments, delivery, governance | benchmark | mixed | active | 2026-08-19 | v1 |
| **Octopus Deploy** | [`octopus-deploy.md`](octopus-deploy.md) | octopus | `delivery-release-gitops` | `delivery-release-gitops` | overlapping | delivery, governance, environments | borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Open Cluster Management** | [`open-cluster-management.md`](open-cluster-management.md) | ocm, red-hat-acm | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `delivery-release-gitops` · `finops-governance-placement` | overlapping | environments, delivery, governance, provider-matching | borrow, integrate, benchmark | implemented | active | 2026-11-11 | pre-v1 |
| **OpenChoreo** | [`openchoreo.md`](openchoreo.md) | choreo-idp, choreo idp | `platform-orchestrators` | `platform-orchestrators` · `portable-application-models` · `developer-portals-idps` · `delivery-release-gitops` | direct | app-graph, environments, typed-contracts, delivery, governance, wiring | displace, borrow, benchmark | mixed | active | 2026-08-19 | v1 |
| **OpenCost** | [`opencost.md`](opencost.md) | open cost | `finops-governance-placement` | `finops-governance-placement` | complementary | finops, observability | standard, integrate, borrow | mixed | active | 2026-08-20 | pre-v1 |
| **OpenShift** | [`openshift.md`](openshift.md) | okd, red hat openshift | `runtime-substrates` | `runtime-substrates` · `hybrid-multicloud-enterprise` · `cloud-application-platforms` | adjacent | runtime-portability, governance, delivery, extensibility | provider-target, benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **OpenStack** | [`openstack.md`](openstack.md) | openinfra | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `runtime-substrates` | complementary | provider-matching, runtime-portability, governance | provider-target, benchmark | mixed | active | 2026-08-20 | v1 |
| **OpsLevel** | [`opslevel.md`](opslevel.md) | opslevel.com | `developer-portals-idps` | `developer-portals-idps` | complementary | app-graph, governance | integrate, borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Port** | [`port.md`](port.md) | getport.io, port.io | `developer-portals-idps` | `developer-portals-idps` · `platform-orchestrators` · `agentic-infrastructure` | complementary | app-graph, governance, extensibility, agent-surface | integrate, borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Porter** | [`porter.md`](porter.md) | porter.run | `cloud-application-platforms` | `cloud-application-platforms` · `platform-orchestrators` · `hybrid-multicloud-enterprise` | overlapping | environments, delivery, provider-matching, identity-secrets, finops | benchmark, provider-target, borrow | mixed | active | 2026-08-19 | v1 |
| **Pulumi** | [`pulumi.md`](pulumi.md) | pulumi cloud, pulumi esc | `infrastructure-from-code` | `infrastructure-from-code` · `portable-application-models` · `hybrid-multicloud-enterprise` | adjacent | authoring, typed-contracts, reconciliation, extensibility, wiring | adopt, borrow, benchmark, integrate | mixed | active | 2026-08-20 | v1 |
| **Qovery** | [`qovery.md`](qovery.md) | — | `cloud-application-platforms` | `cloud-application-platforms` · `platform-orchestrators` | direct | environments, delivery, provider-matching | displace, benchmark | mixed | active | 2026-08-19 | v1 |
| **Radius** | [`radius.md`](radius.md) | radapp | `portable-application-models` | `portable-application-models` · `platform-orchestrators` | overlapping | app-graph, typed-contracts, environments | borrow | mixed | active | 2026-08-19 | v1 |
| **Railway** | [`railway.md`](railway.md) | — | `cloud-application-platforms` | `cloud-application-platforms` | overlapping | authoring, environments, delivery | benchmark | mixed | active | 2026-08-19 | v1 |
| **Rancher Fleet** | [`rancher-fleet.md`](rancher-fleet.md) | fleet, suse fleet | `hybrid-multicloud-enterprise` | `hybrid-multicloud-enterprise` · `delivery-release-gitops` · `runtime-substrates` | adjacent | delivery, provider-matching, reconciliation, environments | borrow, benchmark, integrate | mixed | active | 2026-08-20 | v1 |
| **Red Hat Developer Hub** | [`red-hat-developer-hub.md`](red-hat-developer-hub.md) | rhdh, developer hub | `developer-portals-idps` | `developer-portals-idps` · `hybrid-multicloud-enterprise` | complementary | app-graph, governance, extensibility | integrate, benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **Release** | [`release.md`](release.md) | release.com, releasehub | `cloud-application-platforms` | `cloud-application-platforms` · `delivery-release-gitops` | adjacent | environments, delivery, app-graph | benchmark, borrow | mixed | active | 2026-08-19 | v1 |
| **Render** | [`render.md`](render.md) | — | `cloud-application-platforms` | `cloud-application-platforms` | overlapping | authoring, environments, delivery | benchmark | mixed | active | 2026-08-19 | v1 |
| **Rivet** | [`rivet.md`](rivet.md) | rivetkit | `runtime-substrates` | `runtime-substrates` | adjacent | runtime-portability, replay-migration | adopt, provider-target | mixed | active | 2026-08-20 | v1 |
| **Roadie** | [`roadie.md`](roadie.md) | roadie.io | `developer-portals-idps` | `developer-portals-idps` | complementary | app-graph, extensibility | integrate, benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **ServerKit** | [`serverkit.md`](serverkit.md) | — | `self-hosted-paas` | `self-hosted-paas` · `identity-networking-delivery` | adjacent | delivery, observability, identity-secrets | benchmark, borrow | mixed | active | 2026-08-20 | v1 |
| **shoo.dev** | [`shoo.md`](shoo.md) | — | `identity-networking-delivery` | `identity-networking-delivery` | complementary | identity-secrets | integrate, provider-target | mixed | active | 2026-08-20 | v1 |
| **Spin / Fermyon** | [`spin-fermyon.md`](spin-fermyon.md) | spin, spinkube, fermyon | `runtime-substrates` | `runtime-substrates` | adjacent | runtime-portability, extensibility | adopt, render-target | mixed | active | 2026-08-19 | v1 |
| **SST** | [`sst.md`](sst.md) | sst ion | `infrastructure-from-code` | `infrastructure-from-code` · `portable-application-models` | direct | authoring, typed-contracts, wiring, environments | displace, borrow, benchmark | mixed | active | 2026-08-19 | v1 |
| **StackGen** | [`stackgen.md`](stackgen.md) | appcd | `agentic-infrastructure` | `agentic-infrastructure` · `infrastructure-from-code` | overlapping | authoring, app-graph, governance, typed-contracts | benchmark, borrow | mixed | renamed | 2026-08-20 | v1 |
| **Supabase** | [`supabase.md`](supabase.md) | — | `backend-data-platforms` | `backend-data-platforms` | adjacent | typed-contracts, identity-secrets | provider-target, benchmark | mixed | active | 2026-08-19 | v1 |
| **System Initiative** | [`system-initiative.md`](system-initiative.md) | systeminit, si | `agentic-infrastructure` | `agentic-infrastructure` · `portable-application-models` · `platform-orchestrators` | direct | app-graph, authoring, reconciliation, typed-contracts, agent-surface | displace, borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Tailscale** | [`tailscale.md`](tailscale.md) | tailnet, headscale | `identity-networking-delivery` | `identity-networking-delivery` | complementary | identity-secrets, runtime-portability, governance | adopt, provider-target, borrow, benchmark | mixed | active | 2026-08-20 | pre-v1 |
| **Upsun** | [`upsun.md`](upsun.md) | platform.sh, platformsh, upsun fixed | `cloud-application-platforms` | `cloud-application-platforms` · `platform-orchestrators` | overlapping | environments, authoring, delivery, app-graph, wiring | benchmark, borrow, provider-target | mixed | renamed | 2026-08-19 | v1 |
| **Vantage** | [`vantage.md`](vantage.md) | — | `finops-governance-placement` | `finops-governance-placement` | adjacent | finops, governance, observability | benchmark, integrate, borrow | mixed | active | 2026-08-20 | pre-v1 |
| **Vercel** | [`vercel.md`](vercel.md) | — | `cloud-application-platforms` | `cloud-application-platforms` · `agentic-infrastructure` | overlapping | delivery, environments, agent-surface | benchmark, borrow, provider-target | mixed | active | 2026-08-19 | v1 |
| **Wasm host landscape** | [`wasm-hosts.md`](wasm-hosts.md) | wasmtime cohort | `runtime-substrates` | `runtime-substrates` | adjacent | runtime-portability, extensibility | adopt, render-target | mixed | active | 2026-08-12 | pre-v1 |
| **wasmCloud** | [`wasmcloud.md`](wasmcloud.md) | — | `runtime-substrates` | `runtime-substrates` | adjacent | runtime-portability, extensibility, typed-contracts | adopt, standard | mixed | active | 2026-08-20 | v1 |
| **Wasp** | [`wasp.md`](wasp.md) | open saas, opensaas | `infrastructure-from-code` | `infrastructure-from-code` · `backend-data-platforms` | adjacent | authoring, app-graph | borrow, benchmark | mixed | active | 2026-08-20 | v1 |
| **Winglang** | [`winglang.md`](winglang.md) | wing | `infrastructure-from-code` | `infrastructure-from-code` | adjacent | authoring, typed-contracts | borrow, benchmark | mixed | active | 2026-08-19 | v1 |

### Freshness ledger

Captures are considered stale 180 days after their researched date. Staleness never fails the build — it schedules refresh work: `pnpm run docs:competitors` lists the stale captures on the day it runs.

| Competitor | Researched | State |
| ---------- | ---------- | ----- |
| [Wasm host landscape](wasm-hosts.md) | 2026-08-12 | pre-v1 — rewrite to contract |
| [AWS Amplify](aws-amplify.md) | 2026-08-19 | contract v1 |
| [Backstage](backstage.md) | 2026-08-19 | contract v1 |
| [Control Plane](control-plane.md) | 2026-08-19 | contract v1 |
| [Crossplane](crossplane.md) | 2026-08-19 | contract v1 |
| [Cycloid](cycloid.md) | 2026-08-19 | contract v1 |
| [Dapr](dapr.md) | 2026-08-19 | contract v1 |
| [DuploCloud](duplocloud.md) | 2026-08-19 | contract v1 |
| [Encore](encore.md) | 2026-08-19 | contract v1 |
| [Facets.cloud](facets.md) | 2026-08-19 | contract v1 |
| [Fly.io](flyio.md) | 2026-08-19 | contract v1 |
| [Harness Platform](harness.md) | 2026-08-19 | contract v1 |
| [Heroku](heroku.md) | 2026-08-19 | contract v1 |
| [Humanitec](humanitec.md) | 2026-08-19 | contract v1 |
| [Kratix](kratix.md) | 2026-08-19 | contract v1 |
| [KubeVela](kubevela.md) | 2026-08-19 | contract v1 |
| [KusionStack](kusionstack.md) | 2026-08-19 | contract v1 |
| [Lagoon](lagoon.md) | 2026-08-19 | contract v1 |
| [Massdriver](massdriver.md) | 2026-08-19 | contract v1 |
| [Mia-Platform](mia-platform.md) | 2026-08-19 | contract v1 |
| [Modal](modal.md) | 2026-08-19 | contract v1 |
| [Netlify](netlify.md) | 2026-08-19 | contract v1 |
| [Northflank](northflank.md) | 2026-08-19 | contract v1 |
| [OpenChoreo](openchoreo.md) | 2026-08-19 | contract v1 |
| [Porter](porter.md) | 2026-08-19 | contract v1 |
| [Qovery](qovery.md) | 2026-08-19 | contract v1 |
| [Radius](radius.md) | 2026-08-19 | contract v1 |
| [Railway](railway.md) | 2026-08-19 | contract v1 |
| [Release](release.md) | 2026-08-19 | contract v1 |
| [Render](render.md) | 2026-08-19 | contract v1 |
| [Spin / Fermyon](spin-fermyon.md) | 2026-08-19 | contract v1 |
| [SST](sst.md) | 2026-08-19 | contract v1 |
| [Supabase](supabase.md) | 2026-08-19 | contract v1 |
| [Upsun](upsun.md) | 2026-08-19 | contract v1 |
| [Vercel](vercel.md) | 2026-08-19 | contract v1 |
| [Winglang](winglang.md) | 2026-08-19 | contract v1 |
| [Anonymous container hosts](anon-container-hosts.md) | 2026-08-20 | contract v1 |
| [Antimetal](antimetal.md) | 2026-08-20 | contract v1 |
| [Appvia Wayfinder](appvia-wayfinder.md) | 2026-08-20 | contract v1 |
| [Argo CD](argo-cd.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [.NET Aspire](aspire.md) | 2026-08-20 | contract v1 |
| [Atlassian Compass](atlassian-compass.md) | 2026-08-20 | contract v1 |
| [CapRover](caprover.md) | 2026-08-20 | contract v1 |
| [CAST AI](cast-ai.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [celld](celld.md) | 2026-08-20 | contract v1 |
| [CloudBolt](cloudbolt.md) | 2026-08-20 | contract v1 |
| [Cloudify](cloudify.md) | 2026-08-20 | contract v1 |
| [Convex](convex.md) | 2026-08-20 | contract v1 |
| [Coolify](coolify.md) | 2026-08-20 | contract v1 |
| [Cortex](cortex.md) | 2026-08-20 | contract v1 |
| [Dokku](dokku.md) | 2026-08-20 | contract v1 |
| [Dokploy](dokploy.md) | 2026-08-20 | contract v1 |
| [FinOps tooling cohort](finops-tooling.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [Flux CD](flux-cd.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [Flux Network](flux-network.md) | 2026-08-20 | contract v1 |
| [HPE Morpheus](hpe-morpheus.md) | 2026-08-20 | contract v1 |
| [Infracost](infracost.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [InsForge](insforge.md) | 2026-08-20 | contract v1 |
| [Kamal](kamal.md) | 2026-08-20 | contract v1 |
| [Kubecost](kubecost.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [Kubernetes](kubernetes.md) | 2026-08-20 | contract v1 |
| [Lakebed](lakebed.md) | 2026-08-20 | contract v1 |
| [NetBird](netbird.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [NetScaler](netscaler.md) | 2026-08-20 | contract v1 |
| [Nitric](nitric.md) | 2026-08-20 | contract v1 |
| [Nomad](nomad.md) | 2026-08-20 | contract v1 |
| [Octopus Deploy](octopus-deploy.md) | 2026-08-20 | contract v1 |
| [OpenCost](opencost.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [OpenShift](openshift.md) | 2026-08-20 | contract v1 |
| [OpenStack](openstack.md) | 2026-08-20 | contract v1 |
| [OpsLevel](opslevel.md) | 2026-08-20 | contract v1 |
| [Port](port.md) | 2026-08-20 | contract v1 |
| [Pulumi](pulumi.md) | 2026-08-20 | contract v1 |
| [Rancher Fleet](rancher-fleet.md) | 2026-08-20 | contract v1 |
| [Red Hat Developer Hub](red-hat-developer-hub.md) | 2026-08-20 | contract v1 |
| [Rivet](rivet.md) | 2026-08-20 | contract v1 |
| [Roadie](roadie.md) | 2026-08-20 | contract v1 |
| [ServerKit](serverkit.md) | 2026-08-20 | contract v1 |
| [shoo.dev](shoo.md) | 2026-08-20 | contract v1 |
| [StackGen](stackgen.md) | 2026-08-20 | contract v1 |
| [System Initiative](system-initiative.md) | 2026-08-20 | contract v1 |
| [Tailscale](tailscale.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [Vantage](vantage.md) | 2026-08-20 | pre-v1 — rewrite to contract |
| [wasmCloud](wasmcloud.md) | 2026-08-20 | contract v1 |
| [Wasp](wasp.md) | 2026-08-20 | contract v1 |
| [Alchemy](alchemy.md) | 2026-11-08 | contract v1 |
| [Kargo](kargo.md) | 2026-11-11 | pre-v1 — rewrite to contract |
| [Karmada](karmada.md) | 2026-11-11 | pre-v1 — rewrite to contract |
| [Open Cluster Management](open-cluster-management.md) | 2026-11-11 | pre-v1 — rewrite to contract |

_89 canonical captures across 13 categories; 75 at contract v1._

<!-- END GENERATED: competitor-matrix -->
