---
type: Competitive Reference
title: "Self-Hosted PaaS & Server Deployment — category index"
description: "Category index: Simple self-hosted PaaS and server/container deployment systems."
tags: [hobo, competitors, category]
---

# Self-Hosted PaaS & Server Deployment

> Category index. Full research lives in each canonical capture — see [`../metadata-contract.md`](../metadata-contract.md) for why this page carries rows, not research.

## Category boundary

Simple self-hosted PaaS and server/container deployment systems.

## Why HoBo competes here

HoBo must be runnable on one box with no vendor account. These tools define what 'easy self-host' means and are the DX benchmark for that path.

## Competitors (9)

| Competitor | Role in this category | Directness | Contested HoBo surface | Competitor advantage | HoBo distinction | Posture | Priority |
| ---------- | --------------------- | ---------- | ---------------------- | -------------------- | ---------------- | ------- | -------- |
| [**ServerKit**](../serverkit.md) *(primary)* | self-hosted open-source server control panel with a Go agent fleet — node-attach/Relay reference | adjacent | `delivery`, `observability`, `identity-secrets` | Complete self-host control panel including mail, WAF, backups and an agent fleet. | HoBo's node-attach path is contract-driven and auditable rather than panel-driven. | benchmark, borrow | P3 |
| [**Anonymous container hosts**](../anon-container-hosts.md) | cohort capture of zero-key temporary container hosts used as the Examples Temporary host matrix | adjacent | `provider-matching`, `delivery` | Zero-credential, instant, throwaway hosting with no account friction. | HoBo treats these as scored Bindle provider targets under residency and policy gates, not as an unmanaged escape hatch. | benchmark, provider-target | P3 |
| [**Northflank**](../northflank.md) | full-stack PaaS with BYOC and GPU support — mature container PaaS benchmark | overlapping | `environments`, `delivery`, `governance` | Broad shipped surface — services, jobs, DBs, pipelines, BYOC, GPU. | HoBo is not a hosting business: the same manifest can target Northflank or anything else. | benchmark | P2 |
| [**Lagoon**](../lagoon.md) | open-source delivery platform whose local-equals-production promise is built on reusing the developer's existing docker-compose file as the source of truth | adjacent | `authoring`, `environments`, `delivery`, `runtime-portability` | The lowest-ceremony on-ramp anywhere: annotate the docker-compose.yml you already have, and the same images run locally and in production. | HoBo types the capability rather than naming a translation, and can target managed services, wasm hosts or a local runtime instead of always emitting Kubernetes objects. | benchmark, borrow | P2 |
| [**Coolify**](../coolify.md) *(primary)* | the leading open-source self-hosted PaaS — the clearest demonstration that the Heroku experience can be delivered on a rented VPS with no vendor | overlapping | `authoring`, `delivery`, `environments`, `provider-matching` | Free, open, and complete for its scope: TLS, backups, previews and a 280+ service catalog on servers you own, deployable in minutes. | Coolify deploys containers to servers you pick from a dropdown; HoBo describes capabilities and scores a realization across heterogeneous providers. | benchmark, borrow | P2 |
| [**Kamal**](../kamal.md) *(primary)* | the minimal end of the spectrum — a deployment tool with no control plane, and the strongest argument in the corpus that most teams need less than they think | adjacent | `delivery`, `runtime-portability` | Radical simplicity: one YAML file, one command, no control plane to operate or lose — and it deploys Basecamp's production estate. | Everything above deployment. For one app on a few servers Kamal is sufficient and HoBo is overhead; the comparison only favours HoBo once targets are heterogeneous. | benchmark, borrow | P3 |
| [**Dokku**](../dokku.md) *(primary)* | the long-lived single-server PaaS — proof that the Heroku contract is small enough to reimplement and durable enough to last a decade | adjacent | `authoring`, `delivery`, `extensibility` | Over a decade of stability on one box, with buildpacks and a large plugin ecosystem and no control plane to run. | HoBo is not competing for the single-server job Dokku has done well since before most of this category existed. | benchmark | P3 |
| [**Dokploy**](../dokploy.md) *(primary)* | a younger self-hosted PaaS in a crowding category — evidence of how low the barrier to entry has become | adjacent | `delivery`, `environments` | First-class Docker Compose support as the on-ramp, with multi-server management and fast setup. | HoBo abstracts the capability rather than deploying the container the developer already described. | benchmark | P3 |
| [**CapRover**](../caprover.md) *(primary)* | the self-hosted PaaS that kept a real orchestrator underneath — and inherited the fate of the orchestrator it chose | adjacent | `delivery`, `environments`, `extensibility` | Keeps a real orchestrator underneath — Swarm gives it replicas, rolling updates and rescheduling that SSH-loop competitors lack. | HoBo keeps its runtime behind a port precisely so a substrate's fortunes are not the platform's — the lesson CapRover's Swarm exposure teaches. | benchmark | P3 |

## Navigation

- [All categories](index.md) · [corpus index](../index.md) · [cross-category matrix](../matrix.md) · [gap analysis](../gap-analysis.md)
