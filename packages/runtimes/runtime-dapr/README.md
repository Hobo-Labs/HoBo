# `@hobo/runtime-dapr`

Optional **Camp runtime / component-host adapter** realizing HoBo ports onto **Dapr** building blocks:

| HoBo port / primitive | Dapr realization |
|---|---|
| `ActorHost` / `defineActor` | Virtual actors + placement + reminders |
| `wasi:messaging` / `topic()` | Pub/sub (incl. `pubsub.kafka`) |
| Workflows / steps | **Activity-name mapping only** (permanent non-goal: full engine parity) |

In-process wasm remains the default path. Dapr is opt-in via Camp `runtimeRequirements: ["dapr"]` or explicit wiring.

## Fidelity

The in-memory client and clients without a fidelity declaration report
`simulated`. A caller-supplied client may declare `fidelity: "live"`;
`live: true` requires that declaration. This is the client's assertion, not
proof of connectivity. The runtime host's `ensure` checks the declared live
client's health and reports it unready if the check is missing, fails, or
returns false. In-memory clients do not establish sidecar readiness.

`servePrivate` currently returns the supplied handlers in process. It does not
create a sidecar boundary or a private sandbox.

```ts
import {
  createDaprRuntimeHost,
  createInMemoryDaprClient,
} from "@hobo/runtime-dapr";

const bundle = createDaprRuntimeHost({
  tenantId: "acme",
  campId: "prod",
  client: createInMemoryDaprClient(),
});
const yaml = bundle.generateKafkaPubsubYaml("fromBinding:kafka-bootstrap");
```

## Modes

- **self-hosted:** `dapr run` / local daprd (`HOBO_DAPR_ENDPOINT`)
- **kubernetes:** sidecar injector annotations (control-plane emits; this package generates component YAML)

## Doctor

`diagnoseDaprReadiness()` feeds `hobo doctor`. The host probes an explicitly live client's health before reporting a reachable runtime.

## Permanent non-goals

- Full Dapr workflow engine parity (activity-name map is the supported surface)
- Every Dapr building block beyond actors + pub/sub messaging
- Replacing the default in-process wasm component-host
