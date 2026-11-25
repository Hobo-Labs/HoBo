---
layout: ../../layouts/Docs.astro
title: HoBo for Developers
description: "Developers write Bindles — the app, its resources, wiring, and permissions, in plain code. No YAML, no infra tickets, no cloud console."
---

# HoBo for Developers

**You write [Bindles](/HoBo/primitives/bindles/).** That's the whole job description. A bindle is your app packed into one provider-agnostic bundle — services, resources, wiring, and permissions — written in the same language as the app itself.

## Your artifact

```ts
// src/bindle.ts — this is the only infrastructure you author
import { bindle } from "hobo/bindles";

import { app as api } from "./api";
import { app as web } from "./webapp";

export default bindle("my-app", (b) => {
 const db = b.data();
 const jobs = b.queue();

 const apiSvc = b
.api(() => api.fetch)
.dependsOn(db, jobs) // wiring = typed runtime bindings
.allow("db:read", "db:write", "queue:send"); // least privilege, in the diff

 const webSvc = b.web(() => web.fetch).dependsOn(apiSvc);
 return { db, jobs, api: apiSvc, web: webSvc };
});
```

## Your loop

```sh
hobo dev # offline local camp, hot reload, replay
hobo up # deploy: plan, gate, provision, converge
hobo logs # live-tail through the camp runtime
hobo inspect # time-travel projections of any run
```

## What you never do

- **Pick a cloud.** Placement is the platform team's map and the Dispatcher's math. Your bindle runs wherever it's cheapest to run — and moves when somewhere better opens up, without you editing anything.
- **Write YAML, Terraform, or IAM JSON.** Resources are `b.data()`, `b.queue()`, `b.bucket()`. Permissions are `.allow(...)` next to the code they protect, reviewed in your PR like any other line.
- **File infra tickets.** If the port exists, you declare it and ship. Governance happens in the gate, not in your calendar.

## What your `.allow()` means to everyone else

Your grants are the security team's review surface and the platform's linking contract: deny-by-default, so a resource you didn't declare and a verb you didn't allow simply don't exist at runtime. Keep grants tight and the rest of the pipeline — [policy checks](/HoBo/roles/devsecops/), migration gates, agent audits — stays fast and quiet.

## When you'd peek next door

- Your app needs provider-native tuning: add a typed `.with(...)` annotation — still inside the bindle, still one diff.
- You're curious where your app actually lives today: `hobo inspect topology`. (It's allowed to surprise you. That's the product.)
- You've outgrown one region or cloud: that's [platform territory](/HoBo/roles/platform-engineers/) — your bindle doesn't change.
