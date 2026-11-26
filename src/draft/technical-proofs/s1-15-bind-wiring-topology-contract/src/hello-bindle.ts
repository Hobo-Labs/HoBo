import { addContainer, compileBindleManifest, data, service } from "./bind-reference.js";
import { HELLO_BINDLE_LOCAL_ENDPOINTS } from "./local-binding-resolver.js";
import { bindle, camp, descriptorFromHandle, providerSelection, yard } from "./topology.js";
import type { Camp, Yard } from "./topology.js";
import type { HoboManifest } from "./types.js";

export const LOCAL_RUNTIME = Object.freeze({ kind: "runtime", id: "runtime-local" });

export function buildHelloBindleManifest(): HoboManifest {
  const db = data("db", { paradigm: "relational" });
  const api = service("api", {
    image: "oci://registry.example.com/hello-api@sha256:demo",
    bind: { db },
  });
  const worker = addContainer("worker", "ghcr.io/acme/hello-worker:1", { bind: { db } })
    .withHttpEndpoint!(8080)
    .withEnvironment!("LOG_LEVEL", "debug");

  return compileBindleManifest([db, api, worker]);
}

export function buildHelloBindleTopology(): HelloBindleTopology {
  const db = data("db", { paradigm: "relational" });
  const api = service("api", {
    image: "oci://registry.example.com/hello-api@sha256:demo",
    bind: { db },
  });
  const worker = addContainer("worker", "ghcr.io/acme/hello-worker:1", { bind: { db } })
    .withHttpEndpoint!(8080)
    .withEnvironment!("LOG_LEVEL", "debug");

  const manifest = compileBindleManifest([db, api, worker]);

  const appBindle = bindle("hello-bindle", (collector) => {
    collector.use(descriptorFromHandle(db));
    collector.use(descriptorFromHandle(api));
    collector.use({
      kind: "container",
      name: worker.name,
      stableId: `container:${worker.name}`,
      portRef: ["wasi:http"],
    });
  });

  const devCamp = camp("dev", {
    runtime: LOCAL_RUNTIME,
    defaultProvider: providerSelection("local"),
    bindle: appBindle,
  });

  const localYard = yard("local", { camps: [devCamp] });

  return { manifest, bindle: appBindle, devCamp, localYard } satisfies HelloBindleTopology;
}

export interface HelloBindleTopology {
  readonly manifest: HoboManifest;
  readonly bindle: ReturnType<typeof bindle>;
  readonly devCamp: Camp;
  readonly localYard: Yard;
}

export function localEndpointForDb(): string {
  return HELLO_BINDLE_LOCAL_ENDPOINTS.db.connectionString;
}
