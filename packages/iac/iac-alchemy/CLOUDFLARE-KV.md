# Cloudflare eventual KV for JavaScript Workers

This opt-in target mapping supports a limited, eventual-consistency subset of
KV for JavaScript Worker entrypoints. It does not implement HoBo's WASI guest
store or the `kv.key-value/v1` conformance profile. A target cannot accept a
Bindle that requires WASI or the complete KV profile on the strength of this
mapping. In particular, HoBo's inferred HTTP requirement includes `wasm`; use
explicit requirements that a trusted host can assess truthfully.

An application can declare a provider-neutral Bindle and construct a
Cloudflare-specific adapter view. Apply the choice with
`withCloudflareEventualKv`; Bindles do not accept provider annotations:

```ts
import { bindle, sessionReplay, type BindleRuntimeContext } from "@hobo/bindles";
import {
  bindleCloudflareWorker,
  cloudflareBindings,
  withCloudflareEventualKv,
} from "@hobo/iac-alchemy/cloudflare/runtime";

const app = bindle(
  "catalog",
  // This host-defined capability name must be registered and assessed by the
  // host as eventual, read-only KV; it does not stand for full HoBo KV.
  { require: ["http", "kv-eventual-read"], runtimes: ["javascript"] },
  (b) => {
    const cache = b.kv().allow("get");
    const web = b.web((context?: BindleRuntimeContext) => async () => {
      const bytes = await cloudflareBindings(context).kv("cache").get("title");
      return new Response(bytes === undefined ? "missing" : new TextDecoder().decode(bytes));
    }).with(sessionReplay({ enabled: false })).dependsOn(cache);
    return { cache, web };
  },
);

// Keep `app` for other targets. This view is only for the Cloudflare mapping.
export const cloudflareApp = withCloudflareEventualKv(app, {
  cache: "read-only",
});
export default bindleCloudflareWorker(cloudflareApp, "web");
```

The trusted deployment host constructs its stack from that same adapter view:

```ts
import { mapBindleToAlchemy } from "@hobo/iac-alchemy";
import {
  cloudflareKvProxySource,
  cloudflareNativeKvBindleMappers,
} from "@hobo/iac-alchemy/cloudflare/kv";

// Establish sourceFence before importing the application module. It must
// authenticate and fence both the app graph and the installed proxy graph.
const mapped = mapBindleToAlchemy(
  cloudflareApp,
  cloudflareNativeKvBindleMappers({
    workerModules: { web: absoluteAppModulePath },
    sourceFence,
  }),
  { assessRequirements: trustedAssessRequirements },
);

const sourceRequirements = [
  {
    resourceId: "web", resourceType: "Cloudflare.Worker",
    bindleName: "catalog", applicationName: "web", sourceKind: "worker",
    sourcePath: absoluteAppModulePath,
  },
  cloudflareKvProxySource("catalog", "cache"),
];
// Supply sourceRequirements to the composite guard and mapped to the Alchemy
// stack. The host independently verifies the generated proxy identity.
```

An explicit `read-only` choice requires precisely `.allow("get")` and exposes
`get` and `exists`; reads may be stale or non-monotonic. A `write-only` choice
requires a nonempty subset of `.allow("set", "delete")` and exposes only
those mutations. Read and write grants cannot be combined on one resource:
Cloudflare KV cannot guarantee HoBo's read-your-writes semantics. Missing grants
are refused rather than interpreted as deny-all because HoBo treats an empty
allow list as inferred permissions. The adapter never retries mutations; a
`KV_MUTATION_OUTCOME_UNKNOWN` requires reconciliation before retry. A failed
read yields `KV_READ_UNAVAILABLE`, not a missing value. Keys are limited to 512
UTF-8 bytes and values to 1 MiB. Both are validated before a mutation.

The mapper creates a native Alchemy `Cloudflare.KV.Namespace` and a separate
private `Cloudflare.Worker` per KV resource. The application receives a Worker
service binding only; the proxy holds the namespace and enforces the exact
verbs. `workersDev: false`, `domain: null`, and empty routes are requested for
the proxy. The host must independently verify and fence the deployed bindings,
account IAM, network routes, service access and control-plane changes so the
application cannot acquire the namespace or credentials outside the proxy and
no untrusted caller can reach the proxy. The host must verify the exact proxy
source, its complete transitive imports, module cache, toolchain and final upload
artifact along with the application, keep those guarantees in force through
provider completion, and attest every executable source requirement. A digest
or callback alone does not provide isolation.

The financial target inventory must include the namespace, proxy Worker, app
Worker, and every other billable effect. A supplied pricing model must account
for proxy invocations and the underlying KV operations as well as worker and
storage costs; otherwise the normal unknown-pricing policy applies. The host
is responsible for enforcing any usage bounds assumed by a quote. This adapter
view does not change the application's normal routing or budget policy.
