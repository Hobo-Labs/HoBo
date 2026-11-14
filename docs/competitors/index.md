# HoBo — Competitor references

> Source-backed captures of competing and adjacent products, each with a HoBo parity/mapping section. These ground the design suite ([`../design/`](../design/index.md)) in what already exists.

This page is **navigation**. The corpus has three layers, and each fact lives in exactly one of them:

| Layer | Where | What it holds |
| ----- | ----- | ------------- |
| Canonical capture | `docs/competitors/<slug>.md` | All research on one product. One file per product, no matter how many categories it belongs to. |
| Category index | [`categories/`](categories/index.md) | Category boundary, why HoBo competes there, and one standardized comparison row per member. No research. |
| Derived views | [`matrix.md`](matrix.md) · [`gap-analysis.md`](gap-analysis.md) | Generated cross-category matrix and freshness ledger; cross-competitor synthesis. |

Membership, aliases, posture and freshness are declared once, in each capture's `competitor:` front matter, and validated by `pnpm run docs:competitors`. The schema and canonical path rules are normative in [`metadata-contract.md`](metadata-contract.md).

<!-- BEGIN GENERATED: competitor-index -->

## Categories (13)

| Category | Competitors |
| -------- | ----------- |
| [Comprehensive Platform Orchestrators](categories/platform-orchestrators.md) | [Appvia Wayfinder](appvia-wayfinder.md) · [Argo CD](argo-cd.md) · [CAST AI](cast-ai.md) · [CloudBolt](cloudbolt.md) · [Control Plane](control-plane.md) · [Crossplane](crossplane.md) · [Cycloid](cycloid.md) · [DuploCloud](duplocloud.md) · [Facets.cloud](facets.md) · [Flux CD](flux-cd.md) · [Harness Platform](harness.md) · [HPE Morpheus](hpe-morpheus.md) · [Humanitec](humanitec.md) · [Kratix](kratix.md) · [KubeVela](kubevela.md) · [KusionStack](kusionstack.md) · [Massdriver](massdriver.md) · [Mia-Platform](mia-platform.md) · [Nomad](nomad.md) · [OpenChoreo](openchoreo.md) · [Port](port.md) · [Porter](porter.md) · [Qovery](qovery.md) · [Radius](radius.md) · [System Initiative](system-initiative.md) · [Upsun](upsun.md) |
| [Portable Application Models & Control Planes](categories/portable-application-models.md) | [.NET Aspire](aspire.md) · [Alchemy](alchemy.md) · [Cloudify](cloudify.md) · [Crossplane](crossplane.md) · [Dapr](dapr.md) · [Facets.cloud](facets.md) · [Humanitec](humanitec.md) · [Kratix](kratix.md) · [Kubernetes](kubernetes.md) · [KubeVela](kubevela.md) · [KusionStack](kusionstack.md) · [Massdriver](massdriver.md) · [Nitric](nitric.md) · [OpenChoreo](openchoreo.md) · [Pulumi](pulumi.md) · [Radius](radius.md) · [SST](sst.md) · [System Initiative](system-initiative.md) |
| [Cloud Application Platforms](categories/cloud-application-platforms.md) | [Anonymous container hosts](anon-container-hosts.md) · [AWS Amplify](aws-amplify.md) · [Control Plane](control-plane.md) · [Coolify](coolify.md) · [Encore](encore.md) · [Flux Network](flux-network.md) · [Fly.io](flyio.md) · [Heroku](heroku.md) · [Lagoon](lagoon.md) · [Lakebed](lakebed.md) · [Modal](modal.md) · [Netlify](netlify.md) · [Northflank](northflank.md) · [OpenShift](openshift.md) · [Porter](porter.md) · [Qovery](qovery.md) · [Railway](railway.md) · [Release](release.md) · [Render](render.md) · [Upsun](upsun.md) · [Vercel](vercel.md) |
| [Developer Portals & IDPs](categories/developer-portals-idps.md) | [Appvia Wayfinder](appvia-wayfinder.md) · [Atlassian Compass](atlassian-compass.md) · [Backstage](backstage.md) · [Cortex](cortex.md) · [Cycloid](cycloid.md) · [Harness Platform](harness.md) · [Massdriver](massdriver.md) · [Mia-Platform](mia-platform.md) · [OpenChoreo](openchoreo.md) · [OpsLevel](opslevel.md) · [Port](port.md) · [Red Hat Developer Hub](red-hat-developer-hub.md) · [Roadie](roadie.md) |
| [Infrastructure-from-Code & Authoring](categories/infrastructure-from-code.md) | [.NET Aspire](aspire.md) · [Alchemy](alchemy.md) · [AWS Amplify](aws-amplify.md) · [Encore](encore.md) · [Infracost](infracost.md) · [KusionStack](kusionstack.md) · [Nitric](nitric.md) · [Pulumi](pulumi.md) · [SST](sst.md) · [StackGen](stackgen.md) · [Wasp](wasp.md) · [Winglang](winglang.md) |
| [Runtime & Distributed Application Substrates](categories/runtime-substrates.md) | [.NET Aspire](aspire.md) · [celld](celld.md) · [Control Plane](control-plane.md) · [Dapr](dapr.md) · [Flux Network](flux-network.md) · [Kubernetes](kubernetes.md) · [Modal](modal.md) · [Nomad](nomad.md) · [OpenShift](openshift.md) · [OpenStack](openstack.md) · [Rancher Fleet](rancher-fleet.md) · [Rivet](rivet.md) · [Spin / Fermyon](spin-fermyon.md) · [Wasm host landscape](wasm-hosts.md) · [wasmCloud](wasmcloud.md) |
| [Hybrid & Multicloud Enterprise Orchestration](categories/hybrid-multicloud-enterprise.md) | [Appvia Wayfinder](appvia-wayfinder.md) · [CloudBolt](cloudbolt.md) · [Cloudify](cloudify.md) · [Control Plane](control-plane.md) · [Crossplane](crossplane.md) · [Cycloid](cycloid.md) · [DuploCloud](duplocloud.md) · [Facets.cloud](facets.md) · [HPE Morpheus](hpe-morpheus.md) · [Karmada](karmada.md) · [Kubernetes](kubernetes.md) · [Massdriver](massdriver.md) · [Mia-Platform](mia-platform.md) · [Open Cluster Management](open-cluster-management.md) · [OpenShift](openshift.md) · [OpenStack](openstack.md) · [Porter](porter.md) · [Pulumi](pulumi.md) · [Rancher Fleet](rancher-fleet.md) · [Red Hat Developer Hub](red-hat-developer-hub.md) |
| [Self-Hosted PaaS & Server Deployment](categories/self-hosted-paas.md) | [Anonymous container hosts](anon-container-hosts.md) · [CapRover](caprover.md) · [Coolify](coolify.md) · [Dokku](dokku.md) · [Dokploy](dokploy.md) · [Kamal](kamal.md) · [Lagoon](lagoon.md) · [Northflank](northflank.md) · [ServerKit](serverkit.md) |
| [Agentic Infrastructure & Operations](categories/agentic-infrastructure.md) | [Antimetal](antimetal.md) · [Control Plane](control-plane.md) · [Cortex](cortex.md) · [Harness Platform](harness.md) · [InsForge](insforge.md) · [Lakebed](lakebed.md) · [Port](port.md) · [StackGen](stackgen.md) · [System Initiative](system-initiative.md) · [Vercel](vercel.md) |
| [Backend & Data Application Platforms](categories/backend-data-platforms.md) | [AWS Amplify](aws-amplify.md) · [Convex](convex.md) · [InsForge](insforge.md) · [Supabase](supabase.md) · [Wasp](wasp.md) |
| [Delivery, Release & GitOps](categories/delivery-release-gitops.md) | [Argo CD](argo-cd.md) · [Flux CD](flux-cd.md) · [Harness Platform](harness.md) · [Kamal](kamal.md) · [Kargo](kargo.md) · [Karmada](karmada.md) · [Kratix](kratix.md) · [KubeVela](kubevela.md) · [Lagoon](lagoon.md) · [Octopus Deploy](octopus-deploy.md) · [Open Cluster Management](open-cluster-management.md) · [OpenChoreo](openchoreo.md) · [Rancher Fleet](rancher-fleet.md) · [Release](release.md) |
| [FinOps, Governance & Placement](categories/finops-governance-placement.md) | [Antimetal](antimetal.md) · [CAST AI](cast-ai.md) · [CloudBolt](cloudbolt.md) · [Cycloid](cycloid.md) · [DuploCloud](duplocloud.md) · [Facets.cloud](facets.md) · [FinOps tooling cohort](finops-tooling.md) · [Harness Platform](harness.md) · [HPE Morpheus](hpe-morpheus.md) · [Infracost](infracost.md) · [Kubecost](kubecost.md) · [Open Cluster Management](open-cluster-management.md) · [OpenCost](opencost.md) · [Vantage](vantage.md) |
| [Identity, Networking & Application Delivery](categories/identity-networking-delivery.md) | [Control Plane](control-plane.md) · [NetBird](netbird.md) · [NetScaler](netscaler.md) · [ServerKit](serverkit.md) · [shoo.dev](shoo.md) · [Tailscale](tailscale.md) |

Categories are many-to-many: several products appear in more than one row above, with a single canonical capture behind each link.

## Canonical captures (89)

| Competitor | Capture | Primary category | Directness | Role relative to HoBo |
| ---------- | ------- | ---------------- | ---------- | --------------------- |
| **.NET Aspire** | [`aspire.md`](aspire.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | direct | code-first app composition, local orchestration and deploy — closest authoring analog outside TypeScript |
| **Alchemy** | [`alchemy.md`](alchemy.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | direct | TypeScript-native engine-less IaC — competes on the authoring/provisioning core and is a candidate iac-alchemy adapter |
| **Anonymous container hosts** | [`anon-container-hosts.md`](anon-container-hosts.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | adjacent | cohort capture of zero-key temporary container hosts used as the Examples Temporary host matrix |
| **Antimetal** | [`antimetal.md`](antimetal.md) | [`agentic-infrastructure`](categories/agentic-infrastructure.md) | adjacent | AI-native production-operations layer (world model, RCA, agent handoff) — SRE/operator benchmark |
| **Appvia Wayfinder** | [`appvia-wayfinder.md`](appvia-wayfinder.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | workspace-scoped self-service platform whose Cloud Resource Plans are the same curated-choice mechanism HoBo expresses as Bindle kinds |
| **Argo CD** | [`argo-cd.md`](argo-cd.md) | [`delivery-release-gitops`](categories/delivery-release-gitops.md) | overlapping | the reference GitOps controller — the corpus's clearest statement that drift is a first-class, continuously computed fact rather than an incident |
| **Atlassian Compass** | [`atlassian-compass.md`](atlassian-compass.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | ecosystem-distribution portal — a reminder that in this category integration reach and vendor commitment matter more than architecture |
| **AWS Amplify** | [`aws-amplify.md`](aws-amplify.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | overlapping | Gen-2 code-first TypeScript fullstack backend on AWS CDK — IfC-in-TS analog, AWS-only |
| **Backstage** | [`backstage.md`](backstage.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | CNCF developer portal framework — complementary front-end to a HoBo control plane |
| **CapRover** | [`caprover.md`](caprover.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | adjacent | the self-hosted PaaS that kept a real orchestrator underneath — and inherited the fate of the orchestrator it chose |
| **CAST AI** | [`cast-ai.md`](cast-ai.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | adjacent | automated cost optimization — the cohort's only actor, and the clearest demonstration that acting on cost requires a resilience contract |
| **celld** | [`celld.md`](celld.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | self-hosted Cloudflare Workers/Durable Objects daemon — experimental DO dialect and candidate ActorHost |
| **CloudBolt** | [`cloudbolt.md`](cloudbolt.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | cloud management platform pivoting toward FinOps — evidence that the CMP category's centre of gravity has moved from provisioning to cost |
| **Cloudify** | [`cloudify.md`](cloudify.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | the TOSCA-lineage orchestrator — the corpus's clearest cautionary tale about standards-based portable application models |
| **Control Plane** | [`control-plane.md`](control-plane.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | multi-cloud virtual-cloud runtime — the shipped product closest to HoBo's portability claim, solved at the runtime and identity layer rather than the manifest layer |
| **Convex** | [`convex.md`](convex.md) | [`backend-data-platforms`](categories/backend-data-platforms.md) | adjacent | reactive TypeScript backend-as-a-service — source of the live-query gap and a possible provider target |
| **Coolify** | [`coolify.md`](coolify.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | overlapping | the leading open-source self-hosted PaaS — the clearest demonstration that the Heroku experience can be delivered on a rented VPS with no vendor |
| **Cortex** | [`cortex.md`](cortex.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | catalog-and-scorecards portal whose managed integrations and ownership inference are the operational bar for keeping an estate legible |
| **Crossplane** | [`crossplane.md`](crossplane.md) | [`portable-application-models`](categories/portable-application-models.md) | overlapping | CNCF Kubernetes control plane for infrastructure — borrow-source and pluggable IaC adapter |
| **Cycloid** | [`cycloid.md`](cycloid.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | overlapping | self-service portal over templated IaC whose pre-provision cost estimation and auto-generated topology view are the surfaces HoBo most visibly lacks |
| **Dapr** | [`dapr.md`](dapr.md) | [`runtime-substrates`](categories/runtime-substrates.md) | overlapping | distributed-application runtime with portable building-block APIs — closest architectural analog to Bindle kinds |
| **Dokku** | [`dokku.md`](dokku.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | adjacent | the long-lived single-server PaaS — proof that the Heroku contract is small enough to reimplement and durable enough to last a decade |
| **Dokploy** | [`dokploy.md`](dokploy.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | adjacent | a younger self-hosted PaaS in a crowding category — evidence of how low the barrier to entry has become |
| **DuploCloud** | [`duplocloud.md`](duplocloud.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | overlapping | compliance-first provisioning platform — competes for the same buyer by selling audit evidence rather than portability |
| **Encore** | [`encore.md`](encore.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | direct | infrastructure-from-code for TS/Go that provisions into your cloud — closest product analog |
| **Facets.cloud** | [`facets.md`](facets.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | declarative environment orchestrator — the closest commercial product to HoBo's intent-to-provider thesis, realized through generated Terraform/Helm |
| **FinOps tooling cohort** | [`finops-tooling.md`](finops-tooling.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | adjacent | superseded cohort pointer — per-product captures are canonical; this page retains only the cross-product reading |
| **Flux CD** | [`flux-cd.md`](flux-cd.md) | [`delivery-release-gitops`](categories/delivery-release-gitops.md) | overlapping | the pull-model GitOps controller — the corpus's best argument that the control plane should never hold credentials to the things it manages |
| **Flux Network** | [`flux-network.md`](flux-network.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | adjacent | decentralized container host with a Git-to-Flux deploy UX (Orbit) — compute provider target, not an actor runtime |
| **Fly.io** | [`flyio.md`](flyio.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | global app platform on Firecracker microVMs — edge PaaS competitor and provider target |
| **Harness Platform** | [`harness.md`](harness.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | overlapping | modular commercial DevOps platform whose CD, IDP, IaCM and cost modules each contest a different HoBo surface |
| **Heroku** | [`heroku.md`](heroku.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | the original app-centric PaaS (dynos, buildpacks, add-ons) — the mainstream 'just deploy my app' benchmark |
| **HPE Morpheus** | [`hpe-morpheus.md`](hpe-morpheus.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | the incumbent enterprise cloud-management platform — where hybrid estates already have a self-service catalog, and the integration breadth HoBo will be measured against |
| **Humanitec** | [`humanitec.md`](humanitec.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | Platform Orchestrator for IDPs — the product that proved the dynamic-configuration abstraction HoBo's matching layer descends from |
| **Infracost** | [`infracost.md`](infracost.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | overlapping | plan-time cost estimation — the strongest existing evidence for HoBo's claim that cost belongs at the decision, not in a monthly report |
| **InsForge** | [`insforge.md`](insforge.md) | [`backend-data-platforms`](categories/backend-data-platforms.md) | adjacent | agent-native backend-as-a-service — agent-ops benchmark and possible provider target |
| **Kamal** | [`kamal.md`](kamal.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | adjacent | the minimal end of the spectrum — a deployment tool with no control plane, and the strongest argument in the corpus that most teams need less than they think |
| **Kargo** | [`kargo.md`](kargo.md) | [`delivery-release-gitops`](categories/delivery-release-gitops.md) | overlapping | the promotion-lineage reference HoBo.CD's Freight, Freight sources and pipeline graph are modelled on, without its Kubernetes CRDs or Git-only write path |
| **Karmada** | [`karmada.md`](karmada.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | the multi-cluster placement and failover reference HoBo.CD borrows spread, taints, graceful purge and retained fields from, and an optional single-member transport for Kubernetes Camps |
| **Kratix** | [`kratix.md`](kratix.md) | [`portable-application-models`](categories/portable-application-models.md) | overlapping | framework for building platform APIs — Promises bundle contract, fulfilment and placement, which is the packaging idea HoBo's Bindle kinds most resemble |
| **Kubecost** | [`kubecost.md`](kubecost.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | adjacent | the commercial layer above the cost-allocation standard — evidence that measurement alone does not sell, and recommendations do |
| **Kubernetes** | [`kubernetes.md`](kubernetes.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | the default substrate almost every competitor assumes — a target HoBo supports and a premise HoBo declines |
| **KubeVela** | [`kubevela.md`](kubevela.md) | [`portable-application-models`](categories/portable-application-models.md) | overlapping | reference OAM implementation — the source of HoBo's trait vocabulary and a render target, bounded by its Kubernetes-controller premise |
| **KusionStack** | [`kusionstack.md`](kusionstack.md) | [`portable-application-models`](categories/portable-application-models.md) | direct | open-source intent-driven orchestrator whose AppConfiguration-matched-to-Workspace pipeline is the closest published architecture to HoBo's own |
| **Lagoon** | [`lagoon.md`](lagoon.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | adjacent | open-source delivery platform whose local-equals-production promise is built on reusing the developer's existing docker-compose file as the source of truth |
| **Lakebed** | [`lakebed.md`](lakebed.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | direct | agent-native closed PaaS (Capsules, sync RPC, llms.txt) — named head-on competitor |
| **Massdriver** | [`massdriver.md`](massdriver.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | bundle-and-artifact platform whose JSON-Schema connection contracts are the closest shipped analog to HoBo's typed capability wiring |
| **Mia-Platform** | [`mia-platform.md`](mia-platform.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | enterprise platform orchestrator plus developer portal — owns the same application-to-environment span HoBo does, in one commercial suite |
| **Modal** | [`modal.md`](modal.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | adjacent | Python-first serverless compute for AI/ML with agent Sandboxes — AI-native compute competitor |
| **NetBird** | [`netbird.md`](netbird.md) | [`identity-networking-delivery`](categories/identity-networking-delivery.md) | complementary | self-hostable identity-keyed overlay — the adapter that makes HoBo's air-gapped and sovereign connectivity story credible |
| **Netlify** | [`netlify.md`](netlify.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | composable-web platform (Functions/Edge, Blobs, Netlify DB) — frontend PaaS benchmark |
| **NetScaler** | [`netscaler.md`](netscaler.md) | [`identity-networking-delivery`](categories/identity-networking-delivery.md) | complementary | application delivery controller plus its IaC surface — candidate gateway provider and hobo-import analog |
| **Nitric** | [`nitric.md`](nitric.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | overlapping | cloud-agnostic infrastructure-from-code framework — authoring analog for typed resource declaration |
| **Nomad** | [`nomad.md`](nomad.md) | [`runtime-substrates`](categories/runtime-substrates.md) | overlapping | workload scheduler/orchestrator plus jobspec packaging — direct scheduler/control-plane competitor and provider target |
| **Northflank** | [`northflank.md`](northflank.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | full-stack PaaS with BYOC and GPU support — mature container PaaS benchmark |
| **Octopus Deploy** | [`octopus-deploy.md`](octopus-deploy.md) | [`delivery-release-gitops`](categories/delivery-release-gitops.md) | overlapping | release orchestration and deployment automation — lesson source for promotion, stage gates and runbooks |
| **Open Cluster Management** | [`open-cluster-management.md`](open-cluster-management.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | overlapping | the fleet inventory, rollout-group and governance reference HoBo.CD borrows double opt-in enrollment, Camp sets, decision groups and inform-then-enforce from, and an optional ManifestWork transport for Kubernetes Camps |
| **OpenChoreo** | [`openchoreo.md`](openchoreo.md) | [`platform-orchestrators`](categories/platform-orchestrators.md) | direct | open-source Kubernetes IDP with an explicit developer-intent abstraction layer and a cell-based runtime boundary |
| **OpenCost** | [`opencost.md`](opencost.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | complementary | the cost-allocation standard — a specification HoBo conforms to, and the reason HoBo's non-Kubernetes metering needs an equivalently precise definition |
| **OpenShift** | [`openshift.md`](openshift.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | the enterprise Kubernetes distribution — a provider target, and the clearest evidence that a platform's defaults matter more than its capabilities |
| **OpenStack** | [`openstack.md`](openstack.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | complementary | the open-source IaaS layer under sovereign and on-premise estates — a provider target, and the corpus's clearest lesson about the cost of being a platform of platforms |
| **OpsLevel** | [`opslevel.md`](opslevel.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | portal whose scoped-scorecard model is the sharpest idea in the category: standards proportional to what a service actually is |
| **Port** | [`port.md`](port.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | schema-first developer portal whose Blueprint model is the strongest catalog abstraction in the corpus — a front end HoBo should serve, not fight |
| **Porter** | [`porter.md`](porter.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | BYOC PaaS that owns the customer's cluster — the clearest example of the credit-and-account argument HoBo also makes |
| **Pulumi** | [`pulumi.md`](pulumi.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | adjacent | the IaC engine HoBo stands on — an adopted adapter and borrow-source whose authoring model HoBo agrees with and whose altitude it deliberately sits above |
| **Qovery** | [`qovery.md`](qovery.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | direct | BYOC internal developer platform deploying into your own cloud — PaaS/IDP competitor |
| **Radius** | [`radius.md`](radius.md) | [`portable-application-models`](categories/portable-application-models.md) | overlapping | CNCF cloud-native application platform (app graph, Recipes, connections) — borrow-source for recipes and app model |
| **Railway** | [`railway.md`](railway.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | instant-deploy PaaS with a visual canvas and Railway Metal — mainstream PaaS benchmark |
| **Rancher Fleet** | [`rancher-fleet.md`](rancher-fleet.md) | [`hybrid-multicloud-enterprise`](categories/hybrid-multicloud-enterprise.md) | adjacent | fleet-scale GitOps whose Bundle-to-BundleDeployment split is the clearest separation of definition from per-target realization in the corpus |
| **Red Hat Developer Hub** | [`red-hat-developer-hub.md`](red-hat-developer-hub.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | supported Backstage distribution whose dynamic plugin loading solves the maintenance problem that makes self-hosted Backstage expensive |
| **Release** | [`release.md`](release.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | adjacent | specialist in the one surface HoBo keeps finding it lacks — ephemeral environments that actually look like production, data included |
| **Render** | [`render.md`](render.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | unified managed cloud with render.yaml Blueprints — Heroku-successor PaaS benchmark |
| **Rivet** | [`rivet.md`](rivet.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | open-source Durable Objects / actor runtime — preferred compatible ActorHost resolver |
| **Roadie** | [`roadie.md`](roadie.md) | [`developer-portals-idps`](categories/developer-portals-idps.md) | complementary | hosted Backstage whose exit story — your catalog and templates stay yours — is the cleanest lock-in answer in this cohort |
| **ServerKit** | [`serverkit.md`](serverkit.md) | [`self-hosted-paas`](categories/self-hosted-paas.md) | adjacent | self-hosted open-source server control panel with a Go agent fleet — node-attach/Relay reference |
| **shoo.dev** | [`shoo.md`](shoo.md) | [`identity-networking-delivery`](categories/identity-networking-delivery.md) | complementary | zero-config Google sign-in auth broker (PKCE + ES256/JWKS) — identity integration target |
| **Spin / Fermyon** | [`spin-fermyon.md`](spin-fermyon.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | wasm serverless framework and hosts — SpinKube is a HoBo component-host adapter |
| **SST** | [`sst.md`](sst.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | direct | infrastructure-from-code full-stack framework on Pulumi/Terraform with typed Linking — close product analog |
| **StackGen** | [`stackgen.md`](stackgen.md) | [`agentic-infrastructure`](categories/agentic-infrastructure.md) | overlapping | infrastructure inferred from unannotated source — the one product that removes the declaration step entirely, and the sharpest test of whether HoBo's authoring step is necessary |
| **Supabase** | [`supabase.md`](supabase.md) | [`backend-data-platforms`](categories/backend-data-platforms.md) | adjacent | open-source Postgres BaaS — adjacent platform and possible provider target |
| **System Initiative** | [`system-initiative.md`](system-initiative.md) | [`agentic-infrastructure`](categories/agentic-infrastructure.md) | direct | the most architecturally ambitious rethink of infrastructure automation in the corpus — a live model with real-time qualification instead of a plan-and-apply cycle |
| **Tailscale** | [`tailscale.md`](tailscale.md) | [`identity-networking-delivery`](categories/identity-networking-delivery.md) | complementary | identity-keyed overlay network — an adopted adapter, and the strongest working demonstration that identity, not address, should determine reachability |
| **Upsun** | [`upsun.md`](upsun.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | environment-per-branch PaaS whose cloned-production-data preview environments are the strongest ephemeral-environment implementation in the corpus |
| **Vantage** | [`vantage.md`](vantage.md) | [`finops-governance-placement`](categories/finops-governance-placement.md) | adjacent | multi-cloud cost observability — the corpus's evidence that attribution is an organizational problem before it is a technical one |
| **Vercel** | [`vercel.md`](vercel.md) | [`cloud-application-platforms`](categories/cloud-application-platforms.md) | overlapping | frontend cloud plus durable Workflow SDK and AI stack — borrow-source promoted to full parity capture |
| **Wasm host landscape** | [`wasm-hosts.md`](wasm-hosts.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | cohort capture of the wasm component-hosting landscape grounding ADR-0031 component-host adapters |
| **wasmCloud** | [`wasmcloud.md`](wasmcloud.md) | [`runtime-substrates`](categories/runtime-substrates.md) | adjacent | CNCF wasm component runtime (lattice, wRPC, capability providers) — adopted substrate, HoBo's default host |
| **Wasp** | [`wasp.md`](wasp.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | adjacent | Rails-like full-stack framework driven by a declarative .wasp spec — App-Kit inspiration and packaging path |
| **Winglang** | [`winglang.md`](winglang.md) | [`infrastructure-from-code`](categories/infrastructure-from-code.md) | adjacent | cloud-oriented language compiling to Terraform — authoring analog and cautionary tale (Wing Cloud shut down 2025) |

## Alias index

Renamed, acquired, and commonly-abbreviated products resolve to one canonical capture. There are no stub files for old names — look them up here.

| Alias / former name | Canonical capture |
| ------------------- | ----------------- |
| `akuity-kargo` | [Kargo](kargo.md) |
| `amazee.io lagoon` | [Lagoon](lagoon.md) |
| `amplify gen 2` | [AWS Amplify](aws-amplify.md) |
| `appcd` | [StackGen](stackgen.md) |
| `applicationset` | [Argo CD](argo-cd.md) |
| `appvia` | [Appvia Wayfinder](appvia-wayfinder.md) |
| `argocd` | [Argo CD](argo-cd.md) |
| `captainduckduck` | [CapRover](caprover.md) |
| `cast.ai` | [CAST AI](cast-ai.md) |
| `castai` | [CAST AI](cast-ai.md) |
| `choreo idp` | [OpenChoreo](openchoreo.md) |
| `choreo-idp` | [OpenChoreo](openchoreo.md) |
| `citrix adc` | [NetScaler](netscaler.md) |
| `clawdship` | [Anonymous container hosts](anon-container-hosts.md) |
| `cloudbolt software` | [CloudBolt](cloudbolt.md) |
| `cloudify orchestrator` | [Cloudify](cloudify.md) |
| `compass` | [Atlassian Compass](atlassian-compass.md) |
| `controlplane.com` | [Control Plane](control-plane.md) |
| `coolify.io` | [Coolify](coolify.md) |
| `cortex.io` | [Cortex](cortex.md) |
| `cpln` | [Control Plane](control-plane.md) |
| `cycloid.io` | [Cycloid](cycloid.md) |
| `developer hub` | [Red Hat Developer Hub](red-hat-developer-hub.md) |
| `dockup` | [Anonymous container hosts](anon-container-hosts.md) |
| `dokku.com` | [Dokku](dokku.md) |
| `dokploy.com` | [Dokploy](dokploy.md) |
| `dotnet aspire` | [.NET Aspire](aspire.md) |
| `duplo cloud` | [DuploCloud](duplocloud.md) |
| `facets cloud` | [Facets.cloud](facets.md) |
| `fermyon` | [Spin / Fermyon](spin-fermyon.md) |
| `fleet` | [Rancher Fleet](rancher-fleet.md) |
| `flux` | [Flux Network](flux-network.md) |
| `flux v2` | [Flux CD](flux-cd.md) |
| `flux2` | [Flux CD](flux-cd.md) |
| `fluxcd` | [Flux CD](flux-cd.md) |
| `fly` | [Fly.io](flyio.md) |
| `getport.io` | [Port](port.md) |
| `gitops toolkit` | [Flux CD](flux-cd.md) |
| `harness delegate` | [Harness Platform](harness.md) |
| `harness.io` | [Harness Platform](harness.md) |
| `hashicorp nomad` | [Nomad](nomad.md) |
| `headscale` | [Tailscale](tailscale.md) |
| `k8s` | [Kubernetes](kubernetes.md) |
| `kamal deploy` | [Kamal](kamal.md) |
| `kcl` | [KusionStack](kusionstack.md) |
| `kubecost cohort` | [FinOps tooling cohort](finops-tooling.md) |
| `kubernetes-armada` | [Karmada](karmada.md) |
| `kusion` | [KusionStack](kusionstack.md) |
| `massdriver.cloud` | [Massdriver](massdriver.md) |
| `mia platform` | [Mia-Platform](mia-platform.md) |
| `miaplatform` | [Mia-Platform](mia-platform.md) |
| `morpheus cmp` | [HPE Morpheus](hpe-morpheus.md) |
| `morpheus data` | [HPE Morpheus](hpe-morpheus.md) |
| `mrsk` | [Kamal](kamal.md) |
| `net bird` | [NetBird](netbird.md) |
| `netscaler adc` | [NetScaler](netscaler.md) |
| `nitrictech` | [Nitric](nitric.md) |
| `nomad pack` | [Nomad](nomad.md) |
| `ocm` | [Open Cluster Management](open-cluster-management.md) |
| `octopus` | [Octopus Deploy](octopus-deploy.md) |
| `okd` | [OpenShift](openshift.md) |
| `open cost` | [OpenCost](opencost.md) |
| `open saas` | [Wasp](wasp.md) |
| `openinfra` | [OpenStack](openstack.md) |
| `openpouch` | [Anonymous container hosts](anon-container-hosts.md) |
| `opensaas` | [Wasp](wasp.md) |
| `opslevel.com` | [OpsLevel](opslevel.md) |
| `orbit` | [Flux Network](flux-network.md) |
| `platform.sh` | [Upsun](upsun.md) |
| `platformsh` | [Upsun](upsun.md) |
| `port.io` | [Port](port.md) |
| `porter.run` | [Porter](porter.md) |
| `pulumi cloud` | [Pulumi](pulumi.md) |
| `pulumi esc` | [Pulumi](pulumi.md) |
| `radapp` | [Radius](radius.md) |
| `red hat openshift` | [OpenShift](openshift.md) |
| `red-hat-acm` | [Open Cluster Management](open-cluster-management.md) |
| `release.com` | [Release](release.md) |
| `releasehub` | [Release](release.md) |
| `rhdh` | [Red Hat Developer Hub](red-hat-developer-hub.md) |
| `rivetkit` | [Rivet](rivet.md) |
| `roadie.io` | [Roadie](roadie.md) |
| `runonflux` | [Flux Network](flux-network.md) |
| `si` | [System Initiative](system-initiative.md) |
| `ske` | [Kratix](kratix.md) |
| `spin` | [Spin / Fermyon](spin-fermyon.md) |
| `spinkube` | [Spin / Fermyon](spin-fermyon.md) |
| `spotify backstage` | [Backstage](backstage.md) |
| `sst ion` | [SST](sst.md) |
| `suse fleet` | [Rancher Fleet](rancher-fleet.md) |
| `syntasso kratix` | [Kratix](kratix.md) |
| `systeminit` | [System Initiative](system-initiative.md) |
| `tailnet` | [Tailscale](tailscale.md) |
| `ttl.sh` | [Anonymous container hosts](anon-container-hosts.md) |
| `upsun fixed` | [Upsun](upsun.md) |
| `uselagoon` | [Lagoon](lagoon.md) |
| `vela` | [KubeVela](kubevela.md) |
| `wasmtime cohort` | [Wasm host landscape](wasm-hosts.md) |
| `wayfinder` | [Appvia Wayfinder](appvia-wayfinder.md) |
| `wing` | [Winglang](winglang.md) |
| `zerodeploy` | [Anonymous container hosts](anon-container-hosts.md) |

<!-- END GENERATED: competitor-index -->

> `flux` historically pointed at Flux Network (the decentralized container host). It is now an alias, because Flux CD is a different product in a different category. Always link the canonical slug.

## What a capture contains

Each capture follows the **HoBo Competitive Research Contract**: what it is · core primitives · feature surface · architecture · how it competes with HoBo · primitive mapping · where the competitor is stronger · where HoBo is stronger or intentionally different · adversarial critique · better-together posture · threats and lessons · sources. Captures rewritten to that shape are marked `v1` in the [matrix](matrix.md); earlier captures are real, source-backed research queued for rewrite by their own research issue.

Some entries are **cohort** captures (`anon-container-hosts`, `wasm-hosts`, `finops-tooling`) covering a landscape rather than one product; they are superseded section by section as per-product captures land.

HoBo mappings distinguish **implemented** behaviour in `packages/` from **proof/draft** and **design-only** intent. A category row may never imply parity the repository does not have.

➡️ **Cross-competitor [gap analysis](./gap-analysis.md)** — synthesis of where HoBo's design leads, matches, or falls short, with prioritized gaps and recommended design moves.

## Sources & fair use

These are **third-party reference captures for competitive analysis**. Each file links its upstream source (official docs/repos). Excerpts of **factual interface surface** — API signatures, CLI flags, config/schema shapes, short illustrative snippets, and clearly-attributed status quotes — are reproduced under **fair use for commentary, comparison, and interoperability analysis**, deliberately limited to what's needed to map each product to HoBo. All product names, trademarks, documentation, and code remain the property of their respective owners and are governed by their own licenses; nothing here grants rights to that material. If you own one of these works and want an excerpt adjusted or removed, open an issue. These captures are _not_ part of the HoBo product and carry no HoBo license.
