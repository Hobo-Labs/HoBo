---
layout: ../../layouts/Docs.astro
title: HoBo for Developers
description: "Write a Bindle that describes your app and its dependencies, then run it locally."
---

# HoBo for Developers

A [Bindle](/HoBo/primitives/bindles/) describes an application's services and their dependencies in TypeScript. The checked-in `examples/hello-bindle/src/bindle.ts` uses the Hono adapter for an API and a web app:

```ts
import { honoEntrypoint } from "@hobo/adapter-hono";
import { bindle, env } from "@hobo/bindles";

import { app as api } from "./api.js";
import { app as web } from "./webapp.js";

const campEnv = env({ GREETING_PREFIX: "howdy", APP_TITLE: "howdy" });

export default bindle("hello-bindle", (builder) => {
	const apiService = builder.api(honoEntrypoint(api)).with(campEnv);
	const webService = builder
		.web(honoEntrypoint(web))
		.with(campEnv)
		.dependsOn(apiService);
	return { api: apiService, web: webService };
});
```

The returned object names the services. The web app depends on the API, and both receive the environment values declared in `campEnv`.

From the repository root, install the workspace and run the example:

```sh
pnpm install
pnpm hobo plan --cwd examples/hello-bindle
pnpm hobo up --cwd examples/hello-bindle
pnpm hobo dev --cwd examples/hello-bindle
```

The local lane runs without a cloud account and uses an in-memory Pulumi stand-in. `pnpm hobo dev` serves the application locally. The [getting started guide](/HoBo/guide/getting-started/) covers prerequisites, Camps, Yards, and other examples.
