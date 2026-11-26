---
layout: ../../layouts/Docs.astro
title: What is HoBo?
description: "HoBo is an AI-native meta-cloud with one guiding principle: every app deserves a home, and continuous migration keeps finding it a cheaper one."
---

# What is HoBo?

HoBo is an **AI-native meta-cloud** built on one guiding principle: **every app deserves a home — preferably a cheap one.** You describe your app once, HoBo places it on real infrastructure that passes your policies, and then — this is the part nobody else does — **it keeps looking**. When a better-value home opens up, continuous migration moves your app there, without a rewrite, a war room, or a weekend.

> **Honest status:** HoBo is **pre-release**, and the core loop already runs: pack a Bindle → `hobo plan` / `hobo up` / `hobo dev` against the default local lane, plus the `hobo-mcp` agent surface — with live deploy lanes credential-gated. See [the trail map](/HoBo/guide/status/) for what runs now.

## The pitch

*"Write your app once. HoBo finds it the cheapest home that meets your standards — and moves it when somewhere better opens up. Built for humans and the agents that work for them."*

A developer (or an agent) packs the app into a [**Bindle**](/HoBo/primitives/bindles/), runs `hobo up`, and the app lands in a [**Camp**](/HoBo/primitives/camps/) — inferred on the local lane by default, or pinned by topology you author. [**Yards**](/HoBo/primitives/yards/) select providers; camps describe environments. From then on, placement is a *standing decision*, not a historical one.

## Why "HoBo"?

The name is the philosophy. A hobo travels light, works where the work is, and moves on when a town stops being worth the rent:

- **Travel light.** Everything the app owns fits in its bindle. 
- **Work anywhere.** Ports and adapters mean any conforming provider is a valid home. 
- **Move when it's worth it.** Continuous migration re-plans placement for as long as the app lives. 

## Where to go next

| Path | Start here |
|---|---|
| **Guide** | [Getting started](/HoBo/guide/getting-started/) · [Core concepts](/HoBo/guide/concepts/) · [Trail map](/HoBo/guide/status/) · [CLI intro](/HoBo/guide/cli/) |
| **Architecture** | [Overview](/HoBo/architecture/) · data / control planes · WASM · air-gap |
| **Security** | [Identity](/HoBo/security/identity/) · multi-tenant · credentials |
| **CI/CD** | [Continuous migration](/HoBo/cicd/migration/) · progressive delivery |
| **Primitives** | Bindle, Camp, Yard, Junction, Station, Trail |
| **Operations** | Built-in Yard operators (SRE, GitOps, …) |
| **The Crew** | Custom ACP agents |
| **Testing / Reference** | Full pattern and lookup manuals |
