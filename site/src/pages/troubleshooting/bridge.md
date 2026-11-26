---
layout: ../../layouts/Docs.astro
title: The Bridge
description: "Session-scoped local/remote development on any provider: fork one boundary's traffic to your laptop — contract-verified before it activates — while everyone else's requests stay live. Bridge-to-Kubernetes, without the Kubernetes."
---

# The Bridge

> *Tag your traffic, fork your boundary, keep everyone else live.*

Bridge to Kubernetes had one great idea: develop **one** service on your laptop while it participates in the **real** deployed environment — your requests detour to your machine, everyone else's don't. Its limits were structural: it worked by intercepting pod traffic, so it only worked on Kubernetes.

HoBo's version keeps the idea and drops the requirement. Every service boundary is a WIT port whose peers are PACT-emulable, and every boundary supports per-request routing modes (`live · mock · bridge · replay · shadow · fault`). Forking traffic to your laptop is just one more route — applied **at the WIT port boundary**, not in any orchestrator — so it works identically on any provider, a mix of them, or your own metal.

## The three moves

**1. Tag your traffic.** A dev session is a string — your branch name is the natural one. Session tags ride with requests (as baggage on wire transports; explicitly in-process). Untagged traffic can never hit a fork.

**2. Bridge the boundary.** Point the boundary at the implementation you're editing, scoped to your session:

```ts
import { createBoundaryRouter } from "hobo/runtime";

const router = createBoundaryRouter();
const payments = router
.boundary<Charge, Receipt>("payments")
.live(deployedPayments); // the version running in the camp

await payments.bridge(myLocalPayments, {
 session: "tyler/feature-refunds",
 contract: paymentsPact, // the boundary's PACT interactions
});
```

**3. Work against reality.** Your requests take the bridge; the rest of the team's — and production's — stay live:

```ts
await payments.call(charge, { session: "tyler/feature-refunds" }); // → your laptop
await payments.call(charge); // → the deployed camp
```

Tear it down with `payments.unbridge("tyler/feature-refunds")`. A bridge with **no** session forks the whole boundary — the classic "route this service to me" mode — and `unbridge()` restores it.

## The part Bridge-to-Kubernetes never had

A bridge is **contract-gated**. Before your local implementation carries a single request, it's verified against the boundary's contract — the PACT interactions every implementation of that boundary must satisfy, using the same subset matching as provider verification. A local build that would break consumers **never activates**; the error tells you which interactions failed, and your session's traffic keeps flowing to the live route:

```ts
await payments.bridge(brokenLocalBuild, {
 session: "tyler/feature-refunds",
 contract: paymentsPact,
});
// BridgeContractError: bridged implementation for boundary "payments"
// fails its contract (1 interaction): for input {"amount":42,…}
// expected {"status":"charged",…} ⊆ actual, got {"status":"declined",…}
```

And because **recording is always on**, every call your bridged session serves is captured as a specification-by-example trace — your dev session's traffic becomes tomorrow's contract candidates and regression inputs.

## Composing with preview environments

A dev branch's preview environment is a camp with your branch's session tag pre-applied. The two compose naturally:

- **Preview env alone** — the whole branch deployed, isolated, shareable.
- **Preview env + bridge** — the branch deployed *except* the one service you're actively editing, which detours to your laptop. Save a file, hit the endpoint, no redeploy.
- **Shared env + bridge** — the lightest loop: nothing deployed at all for your branch; just your session forked out of the shared environment.

## The rest of the modes

The bridge is one routing mode of six, and they compose per boundary:

| Mode | What it does | Use for |
|---|---|---|
| `live(handler)` | the deployed route | normal traffic |
| `mock(examples)` | serve PACT examples, no dependency | [unit tests](/HoBo/guide/testing/), offline dev |
| `bridge(handler, { session })` | session-scoped fork | local/remote dev |
| `replay()` | serve recorded outputs | deterministic re-runs |
| `shadow(candidate)` | duplicate traffic, compare, discard | testing the next version on real load |
| `fault({ message, session })` | scoped failure injection | [chaos with no blast radius](/HoBo/testing/chaos/#session-scoped-faults) |

`router.status()` reports every boundary's routing state — who's bridged, what's shadowed, which faults are armed — so "what is my environment actually doing right now" is one call.

## Honest status

The boundary router above ships today with in-process session tagging, and its tests are the executable example of everything on this page. Session baggage on wire transports, the `hobo bridge` CLI verb (open tunnel, register fork, stream contract verification), automatic pact-broker → bridge-contract conversion, and branch-tagged preview environments are staged next — the design is pinned even where the plumbing isn't.

## Related

- [Testing](/HoBo/guide/testing/) — the same modes, pointed at tests.
- [Core concepts](/HoBo/guide/concepts/) — WIT/WASM ports the routing lives in.
- [Custom providers](/HoBo/customizations/providers/) — why boundaries are provider-agnostic in the first place.
