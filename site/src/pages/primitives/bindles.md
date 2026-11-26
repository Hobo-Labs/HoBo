---
layout: ../../layouts/Docs.astro
title: Bindles
description: "The Bindle is HoBo's first primitive: your whole app — services, resources, wiring, and permissions — packed into one provider-agnostic bundle that's cheap to move."
---

# Bindles

> *A hobo's bindle is everything they own, tied to a stick. If it doesn't fit in the bindle, it doesn't come along.*

The **Bindle** is HoBo's first primitive and the only thing HoBo ships. It's your whole application — services, resources, wiring, policies, deployment intent — packed into one **provider-agnostic** bundle. You cannot run HoBo without one, and the discipline it imposes is the whole business model: an app that fits in its bindle is an app that's cheap to move, and an app that's cheap to move is an app whose rent goes down.

## Declaring a bindle

A bindle is plain code, and this surface ships today in `hobo/bindles`: the default export of your project's `src/bindle.ts` is exactly what `hobo collect`, `hobo plan`, `hobo up`, and `hobo dev` load (a committed `hobo.bindle.json` manifest artifact wins when present). `bindle(name, build)` hands your build function a resource builder; the object you return *is* the manifest:

```ts
import { bindle } from "hobo/bindles";

import { app as api } from "./api";
import { app as web } from "./webapp";

export default bindle("my-app", (b) => {
 const db = b.data().allow("read", "write");
 const jobs = b.queue().allow("enqueue");
 const cache = b.kv().allow("get", "set");
 const uploads = b.bucket();
 const apiKey = b.secret().allow("access");

 const apiSvc = b
.api(() => api.fetch)
.dependsOn(db, jobs, cache, apiKey);

 const webSvc = b.web(() => web.fetch).dependsOn(apiSvc);

 return { db, jobs, cache, uploads, apiKey, api: apiSvc, web: webSvc };
});
```

## App Kits vs Infra Kits

Resources fall into two authoring families:

| Family | Kinds | Session Replay |
|---|---|---|
| **[App Kits](/HoBo/primitives/app-kits/)** | `api`, `web`, `service`, `ui`, `websocket`, `job`, `wasm-component` | **Default-on** (privacy-first) |
| **Infra Kits** | `data`, `kv`, `bucket`, `queue`, `topic`, `secret`, … | Off unless explicitly annotated |

WIT/WASM is how ports and providers link at runtime; App Kits are the Bindle-facing surfaces you declare.

## The builder surface

| Builder | Kind | Family | What it declares |
|---|---|---|---|
| `b.api(handler?)` | `api` | App Kit | HTTP API entrypoint. **Session Replay default-on.** |
| `b.web(handler?)` | `web` | App Kit | Web app entrypoint. **Session Replay default-on.** |
| `b.service(handler?)` | `service` | App Kit | Long-running service. **Session Replay default-on.** |
| `b.data()` | `data` | Infra Kit | A SQL-ish managed data port. |
| `b.kv()` | `kv` | Infra Kit | Key-value storage. |
| `b.bucket()` | `bucket` | Infra Kit | Object storage. |
| `b.queue()` | `queue` | Infra Kit | Point-to-point work queue. |
| `b.topic()` | `topic` | Infra Kit | Pub/sub topic. |
| `b.secret()` | `secret` | Infra Kit | A secret reference — never a secret value. |

Every resource supports three chainable refinements:

| Method | Meaning |
|---|---|
| `.dependsOn(...resources)` | Declares wiring edges **and** injects typed bindings at runtime. Deny-by-default: no declared edge, no access. |
| `.allow(...verbs)` | Inline least privilege, with verbs typed per resource kind (`"read"`/`"write"`/`"query"` on `data`, `"enqueue"`/`"dequeue"` on `queue`, `"get"`/`"set"` on `kv`, …). Permissions travel in the bindle. |
| `.with(...annotations)` | Typed provider-specific options — the escape hatch. Includes `sessionReplay(...)` to opt a Kit out of Session Replay or set sample rate. |

## Session Replay on every App Kit

Every App Kit is annotated with platform option `session-replay` by default — **api, web, service, ui, websocket, job, wasm-component**, not only `web`. Local `hobo dev` wraps HTTP App Kits: HTML gets a privacy-first bootstrap; `/__hobo/replay/*` serves ingest/list — **no app tracker code required**.

```ts
import { sessionReplay } from "hobo/bindles";

// opt out one Kit
b.api(() => handler).with(sessionReplay({ enabled: false }));
```

Details: [Session Replay](/HoBo/reference/session-replay/) · [App Kits](/HoBo/primitives/app-kits/).

## Greenfield: declare the bindle, generate the code

Packing an existing app — the brownfield path above — is only half the story. A component can also be **declared**: a `@component` class whose `@operation` methods carry the groundings HoBo generates code from — an **intent** (what it's for, in prose), a **contract declaring the shape** (typed input and output, plus invariants and forbidden outputs — the boundary generated code may never cross; the shape is never optional), and an optional **rubric** (named scorers with promotion thresholds, enforced as policy at the gate — omit it and the gate defaults to exact-match over your contract's examples). An operation with a `stub()` body is **code to be generated**; a hand-written body is a baseline the optimizer improves.

```ts
import { bindle } from "hobo/bindles";
import { component, operation, param, stub } from "hobo/runtime";
import { z } from "zod";
import { Cart, Order, Photo, RankInput, submitOrder } from "./domain";

@component({ intent: "Public storefront API: ranked feed, cart, checkout." })
class Storefront {
 @operation({
 intent: "Order photos to maximize dwell without burying brand-new sellers.",
 contract: {
 input: RankInput, // the shape — required
 output: z.array(Photo),
 forbiddenOutputs: ["output[0] is nsfw"],
 },
 params: { input: param("Candidate photos with engagement signals") },
 rubric: { dwellLift: 0.8, newSellerShare: 0.75 }, // optional — sharpens the gate
 })
 rankFeed = stub<RankInput, Photo[]>(); // no implementation: generate it

 @operation({
 intent: "Turn a priced cart into an order exactly once.",
 contract: { input: Cart, output: Order },
 })
 async checkout(cart: Cart): Promise<Order> {
 "use training"; // hand-written baseline the optimizer keeps improving
 return submitOrder(cart);
 }
}

/** The bindle hands the declared component straight to the builder. */
export default bindle("snapshop", (b) => {
 const photos = b.bucket();
 const catalog = b.data().allow("read", "write");
 const api = b.api(Storefront).dependsOn(catalog, photos);
 return { photos, catalog, api };
});
```

`rankFeed` has zero implementation, and the loop from declaration to running code is the same convergence loop as everything else in HoBo:

1. **Declare.** The bindle above is a complete, plannable manifest — `hobo plan` and `hobo up` work on it unchanged. Under the hood each `@operation` lowers to a **trainable** bound to its resource — signature-only for stubbed operations. That's the same machinery as `"use training"`, but you never touch it directly.
2. **Stub.** `hobo stub` emits the generated registrations and a typed client into your project's generated output. Every declared operation is servable from day one by a **contract-derived stub**, so the whole app runs end-to-end before any implementation exists — and every stub call is recorded as a **specification-by-example** trace.
3. **Generate.** The same **generation pipeline** that writes [provider adapters](/HoBo/customizations/providers/) synthesizes each operation's implementation from its interface + contract + recorded traces, in a capability-scoped sandbox with no egress.
4. **Gate.** Promotion needs all three lenses: **conformance green** (the contract must never break), **eval thresholds met** (the rubric — scorer by scorer), and **policy allows** (prod promotions can require human approval).
5. **Promote.** A passing candidate is written back into the operation's generated region as an AST-aware edit with signed provenance — auto-applied when low-risk, raised as a PR when not. Prior candidates live in the event log, so promotion is reversible.

Prefer declaring one grounding at a time? Every decorator is optional and the options object decomposes into **granular decorators** — `@intent`, `@returns` on methods, `@description` on parameters (in legacy-decorator projects; as a `params:` value under standard decorators), with a bare `@trainable` composing the class. The declaration can even be **ambient** — a `declare class` with only signatures, no bodies at all — which `hobo stub` scans statically, taking the TypeScript signature as the declared shape:

```ts
@trainable
export declare class Program {
 @intent("Produce a simple hello-world program")
 @returns("Hello World! or Hello, <name>! when supplied")
 trainableMethod(
 @description("Optional person to greet")
 name?: string,
 ): string;
}
```

Anything you don't declare is inferred: intent from the method name, a synthesized `decl://` contract ref, the default exact-match rubric.

Escalation is **per operation, not per app** — `Storefront` above already shows all three rungs. Swap `rankFeed`'s `stub()` for a real body when you're ready to own it; keep `"use training"` on it (like `checkout`) and the optimizer keeps improving the body against the same intent + contract + rubric, under the same gates; drop the directive and it's plain hand-maintained code. The manifest never changes shape along the way.

Brownfield and greenfield converge on the same artifact: one manifest, one `hobo up`, one event log. Pack code you have, declare code you don't, and mix freely — a half-implemented bindle is a normal bindle.

## Rules the bindle enforces

- **Names come from the returned object keys.** `{ db, api }` yields stable IDs like `data:db` and `api:api`. Duplicate stable IDs are a hard error.
- **The manifest is pure data.** Serializing a bindle yields exactly `{ name, resources, edges }` — handlers are reachable for tooling via `definition.entrypoint(name)` but never leak into the graph.
- **Everything is frozen.** A built bindle is deeply immutable. The manifest you planned against is the manifest that ships.
- **Provider-agnostic by construction.** Nothing in the builder surface names a cloud. Provider choices live in [Camps](/HoBo/primitives/camps/); provider *hints* live in `.with(...)` annotations, which any other provider is free to ignore.

## Why this shape matters

Every classic lock-in mechanism is a thing that lives *outside* your app description: the console-clicked queue, the IAM policy in a wiki, the env var that only exists in one region. The bindle's job is to leave nothing outside. When permissions (`.allow`), wiring (`.dependsOn`), and intent are all in the bundle, **unpacking it somewhere cheaper is a mechanical operation** — which is what lets [continuous migration](/HoBo/guide/concepts/#continuous-migration) be routine rather than heroic.

## Where bindles go next

- A bindle needs a home: [Camps](/HoBo/primitives/camps/) — pitch one to pin placement, or let HoBo infer it from the code you've configured.
- Multiple homes under one provider: [Yards](/HoBo/primitives/yards/).
- Homes across clouds: [Junctions](/HoBo/primitives/junctions/).
