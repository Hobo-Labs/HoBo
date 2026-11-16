# `@hobo/runtime-cloud-native`

Camp **component host** for `componentHost=cloud-native`.

Registry of multi-cloud host providers. Scaffold includes:

| Provider | Status |
|----------|--------|
| `mock` | In-process handlers for setup/parity tests |
| `cloudflare` | **Real (credential-gated)** — token verify + remote-proxy mesh handlers |
| `aws` / `gcp` / `azure` / `vercel` | Declared-unimplemented stubs (ensure ok, serve fails closed with `HOBO_CLOUD_NATIVE_UNIMPLEMENTED`) |

```ts
import { createCloudNativeRuntimeHost } from "@hobo/runtime-cloud-native";

const host = createCloudNativeRuntimeHost({ defaultProvider: "mock" });
await host.ensure({ hoboHome });
```

## The FetchHandler mesh contract is the hard seam for remote providers

Every provider — local mock or remote cloud — realizes the same
`servePrivate` contract: a `Map<resourceName, FetchHandler>` plus isolation
info. For remote providers the handler cannot run the component in-process,
so the seam is proven by **request formation + credential gating**, not by
faking execution:

- **`ensure` is credential-gated and fails closed.** Without
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (presence-only checks;
  values are never logged) it returns `ready: false` with
  `details.credentialGated: true` and the exact `missing` env-var names.
  With credentials it verifies the token via
  `GET https://api.cloudflare.com/client/v4/user/tokens/verify` through an
  injected fetch (parse-don't-validate: `success: true` +
  `result.status === "active"`); anything else throws a typed
  `CloudflareCloudNativeError` with remediation text.
- **`servePrivate` returns honest remote-proxy handlers.** A resource whose
  public endpoint is bound via
  `bindleEnv["HOBO_CLOUD_NATIVE_ENDPOINT_<RESOURCE>"]` gets a handler that
  proxies the incoming request (method, path, query, headers, body) to that
  endpoint and relays status + body verbatim. An unbound resource answers
  `501` with a machine-readable body
  `{ error: "cloudflare-remote-handler-unbound", resource, remediation }` —
  an honest partial realization, never a fake `200`. Isolation reports
  `isolateBoundary: "cloudflare-worker"`, `privateSandboxes: 0`,
  `details.mode: "remote-proxy"`.

`aws` / `gcp` / `azure` / `vercel` remain declared-unimplemented and fail
closed: `ensure` reports `implemented: false` and `servePrivate` throws
`HOBO_CLOUD_NATIVE_UNIMPLEMENTED`. The registry's `ensure` surfaces a
credential-gated provider's gate in its notes without blocking overall
registry readiness (the default serving path is `mock`).

## Architecture rules

Parse, don't validate: cloud-native deployment and runtime inputs are parsed
once at the host boundary into derived types; controllers downstream operate
on those parsed domain values instead of re-validating raw manifests.
