---
layout: ../../layouts/Docs.astro
title: Getting started
description: "Pack your first Bindle, pitch a Camp (or let HoBo pitch it for you), and let your app ride — plus where Yards and Junctions come in."
---

# Getting started

Time to leave home. This guide takes you from an empty directory to an app that has a home — and a standing ticket to a cheaper one. You'll meet HoBo's two foundational primitives, in the order you need them:

1. **[Bindle](/HoBo/primitives/bindles/)** — *pack.* Everything your app owns, rolled into one provider-agnostic bundle. The one thing you must write: no bindle, nothing to host.
2. **[Camp](/HoBo/primitives/camps/)** — *settle.* The environment shape your app occupies (prod/staging/…). Every app lives in a camp, but **writing one is optional** — leave it out and HoBo infers a camp. **Provider selection lives on the [Yard](/HoBo/primitives/yards/)**, not inside the camp.

**[Yards](/HoBo/primitives/yards/)** and **[Junctions](/HoBo/primitives/junctions/)** are advanced scenarios — pin a provider, multi-region, or multi-cloud. Short section [at the end](#advanced--yards-and-junctions).

> **Pre-release note:** `@hobo/*` is **not on npm**. Public `npx hobo` is a *different* package. The local lane (`collect` / `plan` / `up` / `dev`) runs **after** you clone this repo, install with pnpm, and build the workspace. Default IaC is still an **in-memory Pulumi stand-in**. Live Cloudflare/Vercel/Pulumi lanes are credential-gated.

## Prerequisites

- **Node.js** ≥ 22 (`node:sqlite`; CI uses 24). TypeScript is the first reference implementation.
- **pnpm** 10 (`packageManager` in the repo root). A GitHub zip without `external/ts-autocode` is incomplete — clone with submodules / the full tree.
- No cloud account for the local lane.

## Run the local lane (clone — not npm)

```sh
git clone --recurse-submodules https://github.com/Tyler-R-Kendrick/HoBo.git
cd HoBo
pnpm install
pnpm hobo doctor --cwd examples/hello-bindle
pnpm hobo plan --cwd examples/hello-bindle
pnpm hobo up --cwd examples/hello-bindle
pnpm hobo dev --cwd examples/hello-bindle   # serves a live local URL
```

`pnpm hobo` is the supported invocation — it builds `@hobo/hobo` and
`@hobo/adapter-hono` on first use, so there is no separate build step to
forget. (`pnpm --filter @hobo/hobo exec hobo …` does **not** work: pnpm never
links a package's own bin into its own `node_modules/.bin`.)

Do **not** run `npx hobo`. Use the composed `@hobo/hobo` binary from this workspace via `pnpm hobo`. `hobo new` exists on that binary only; it is not a public npm scaffold.

The same commands deploy the apps the [Examples console](/HoBo/examples/)
shows — they share one catalog:

```sh
pnpm hobo up --cwd examples/try-site/apps/hello-world
pnpm hobo plan --cwd examples/try-site/apps/todo-api
```

## Step 1 — Pack your bindle

The bindle is the first thing HoBo looks for and the only thing it ships. It's plain code — no YAML sidecar, no config dialect:

```ts
// src/bindle.ts
import { bindle } from "@hobo/bindles";

import { app as api } from "./api";
import { app as web } from "./webapp";

export default bindle("my-app", (b) => {
 const db = b.data().allow("read", "write"); // a SQL-ish data port, least-privilege verbs inline
 const jobs = b.queue().allow("enqueue"); // background work

 const apiSvc = b
.api(() => api.fetch) // HTTP API entrypoint
.dependsOn(db, jobs); // typed bindings, injected at runtime

 const webSvc = b.web(() => web.fetch).dependsOn(apiSvc);

 return { db, jobs, api: apiSvc, web: webSvc };
});
```

Three things to internalize — they're what make everything later cheap:

- **Resource names come from the returned object keys.** `{ db, jobs, api, web }` is your app's topology; the object *is* the manifest.
- **`.dependsOn(...)` is the wiring.** It declares edges *and* injects typed bindings at runtime. Nothing reaches a backend it didn't declare — deny by default.
- **`.allow(...)` is inline least privilege.** Verbs are scoped to the resource's kind — `"read"`/`"write"` on a data port, `"enqueue"` on a queue, `"get"`/`"set"` on a kv store. Permissions travel *in* the bindle, so they move when the app moves. That's the trick: a bindle carries everything needed to unpack it anywhere, which is exactly what makes migrating to a cheaper home a routine event instead of a rewrite.

That's a complete description. Against a **built** `@hobo/hobo` binary, `hobo up --cwd examples/hello-bindle` converges on the default **local lane** (offline, durable SQLite journal, in-memory Pulumi stand-in — not live multi-cloud). If a committed `hobo.bindle.json` is present it wins; otherwise the manifest is compiled from `src/bindle.ts`.

> **Starting from nothing?** You don't need existing code to pack a bindle. Declare a `@component` class whose `@operation` methods carry an intent, a typed contract shape, and an optional rubric — a `stub()` body declares *code to be generated* — and hand it straight to `b.api(...)`. See [Greenfield: declare the bindle, generate the code](/HoBo/primitives/bindles/#greenfield-declare-the-bindle-generate-the-code).

## Step 2 — Camps (optional) and providers (on the Yard)

A **camp** answers *what environment is this?* — not *which cloud account*. Camps declare env type, labels, and runtime **requirements**. They do **not** own the Bindle and do **not** select providers.

```ts
// src/camps.ts — optional; omit entirely for inferred local camps
import { camp } from "@hobo/camps";

export const prod = camp("prod", {
  envType: "prod",
  runtimeRequirements: ["runtime-local"],
});
```

**Provider selection belongs on the Yard** (advanced — day one can skip this and use the local lane):

```ts
// src/yard.ts
import { yard } from "@hobo/yards";
import { prod } from "./camps";

export default yard("aws-east", {
  provider: "aws",
  regions: ["us-east-1"],
  camps: [prod],
});
```

Converge:

```sh
hobo plan --camp prod   # dry run: placement, cost, warnings — read-only
hobo up --camp prod     # build, plan, gate, provision, deploy
hobo logs --camp prod   # live-tail through the camp runtime
```

Useful truths:

- **The camp is a *current address*, not a vow.** The bindle stays provider-agnostic so the home can change. Continuous migration reuses plan → gate → converge.
- **Writing a camp is optional.** No camp file → inferred local camp on the default lane. Explicit camps pin env semantics or satisfy locked-down placement policy.
- **Zero-setup first deploy:** after the workspace build above, `hobo up` / `hobo dev` need no cloud credentials. `hobo login` mints a local dev session; `hobo claim` binds an anonymous deployment to an account later. **Live** lanes are credential-gated: Cloudflare (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), Vercel (`VERCEL_TOKEN`), or live IaC credentials.
- **Provider-native power stays in the Bindle** as additive annotations (not a rewrite):

```ts
import { aws } from "@hobo/provider-aws";

const apiSvc = b
  .api(() => api.fetch)
  .with(aws.with.fargate({ cpu: 512, memoryMiB: 1024 }));
```

**You now know everything required to run HoBo.** A bindle is the whole entry fee. Everything below is for apps with wanderlust.

## Advanced — Yards and Junctions

Skip this on day one. Come back when you pin a provider or go multi-cloud.

### Yard: one provider, many camps

```ts
import { camp } from "@hobo/camps";
import { yard } from "@hobo/yards";

export default yard("aws", {
  provider: "aws",
  regions: ["us-east-1", "us-west-2"],
  camps: [
    camp("prod-east", { envType: "prod" }),
    camp("prod-west", { envType: "prod" }),
  ],
});
```

One yard per provider. Multi-region = several camps under one yard. Multi-cloud = several yards under a junction.

### Junction: many yards, many clouds

> **Early-stage:** `junction()` authoring and plan derivation ship; each yard still realizes its own half. Full multi-cloud realization is on the [trail map](/HoBo/guide/status/).

```ts
import { junction } from "@hobo/junctions";
import awsYard from "./yards/aws";
import azureYard from "./yards/azure";

export default junction("my-app", { yards: [awsYard, azureYard] });
```

Requires **at least two** member yards. Continuous migration then has a bigger map; residency and sovereignty policy decide what may cross which border.

## Where to next

- [Bindles](/HoBo/primitives/bindles/) and [Camps](/HoBo/primitives/camps/) — the full reference for the two primitives you just used.
- Worked examples ship with the product docs and starter templates.
- [Core concepts](/HoBo/guide/concepts/) — the vocabulary in one sitting.
- [The hobo CLI](/HoBo/guide/cli/) — the whole verb surface (it's deliberately small).
- [HoBo for agents](/HoBo/agents/) — pointing an AI agent at HoBo? It gets its own credentials, not yours.
