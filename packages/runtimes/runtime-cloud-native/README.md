# `@hobo/runtime-cloud-native`

Camp **component host** for `componentHost=cloud-native`.

Registry of multi-cloud host providers:

| Provider | Status |
|----------|--------|
| `mock` | In-process handlers for setup/parity tests |
| `cloudflare` | Credential-gated token verification and remote endpoint handlers |
| `aws` | Credential-gated Lambda endpoint handlers |
| `gcp` | Credential-gated Cloud Run endpoint handlers |
| `azure` | Credential-gated Functions endpoint handlers |
| `vercel` | Credential-gated Functions endpoint handlers |

```ts
import { createCloudNativeRuntimeHost } from "@hobo/runtime-cloud-native";

const host = createCloudNativeRuntimeHost({ defaultProvider: "mock" });
await host.ensure({ hoboHome });
```

The mock provider restores an injected environment value when its host closes
only if the value still matches the injection, preserving later changes made by
the caller.

## Remote providers

Every provider realizes the same
`servePrivate` contract: a `Map<resourceName, FetchHandler>` plus isolation
information.

- `ensure` returns `ready: false` and names missing credential variables.
- Credential values are not included in results or progress messages.
- Cloudflare verifies its token before reporting ready.
- Other providers accept their standard static, profile, workload identity,
  or managed identity environment credentials.
- `servePrivate` proxies each request through
  `bindleEnv["HOBO_CLOUD_NATIVE_ENDPOINT_<RESOURCE>"]`.
- Request paths stay on the bound endpoint origin. Redirects within that origin
  are returned to the caller; redirects outside it return `502`.
- An unbound resource returns HTTP 501 with a machine-readable remediation.

The default registry remains ready when optional cloud credentials are absent;
selecting a cloud provider still exposes its credential gate directly.
