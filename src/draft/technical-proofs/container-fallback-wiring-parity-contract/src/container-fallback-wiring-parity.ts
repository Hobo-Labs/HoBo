import {
  compileBindleManifest,
  data,
  service,
} from "../../bind-reference-wiring-contract/src/bind-reference-contract.js";
import { validateManifest } from "../../hobo-manifest-contract/src/manifest.js";
import { isJsonObject, isJsonString, type JsonValue, type JsonObject } from "./json.js";


export const WIRING_PARITY_SCHEMA = "hobo.containerFallbackWiringParity/v1";
export const MULTI_CLOUD_SHOP_FIXTURE = "examples/multi-cloud-shop";

const RUNTIME_SPECIFIC_KEYS = new Set([
  "runtime",
  "image",
  "exports",
  "build",
]);

export class WiringParityError extends Error {
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "WiringParityError";
    this.path = path;
  }
}

export type RuntimeMode = "wasm" | "container";

export type ConfigEntry = {
  key: string;
  source:
    | { kind: "binding"; ref: string }
    | { kind: "secret-ref"; ref: string }
    | { kind: "camp-env"; ref: string };
  required?: boolean;
};

export type WiringProjection = {
  links: Array<{ import: string; to: string }>;
  env: Record<string, string>;
  config: Record<string, string>;
  bindings: Record<string, { port: string; resource: string; clientType: string }>;
};

export function aspireServiceEndpointKey(
  serviceName: string,
  endpointName: string,
  index = 0,
): string {
  return `services__${serviceName}__${endpointName}__${index}`;
}

export function aspireConnectionStringKey(bindingName: string): string {
  return `ConnectionStrings__${bindingName}`;
}

export function createMultiCloudShopWiringFixture(runtimeMode: RuntimeMode = "wasm") {
  const orders = data("orders", { paradigm: "relational" });
  const assets = data("assets", { paradigm: "document" });
  const api = service("api", {
    image:
      runtimeMode === "container"
        ? "ghcr.io/acme/multi-cloud-shop-api:1.4.0"
        : "oci://registry.example.com/multi-cloud-shop-api@sha256:abc123",
    bind: { orders, assets },
  });

  const manifest = compileBindleManifest([orders, assets, api]);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const apiResource = manifest.resources.api as JsonObject;
  injectConfigEnv(apiResource, defaultMultiCloudShopConfig());
  manifest.resources.frontend = {
    type: "component.v1",
    env: {
      [aspireServiceEndpointKey("api", "http")]: "{api.endpoints.http.url}",
    },
    bindings: {
      api: {
        port: "wasi:http",
        resource: "api",
        clientType: "HttpClient",
      },
    },
  };

  return applyRuntimeArtifacts(manifest, runtimeMode);
}

export function applyRuntimeArtifacts(
  manifest: { schema: string; resources: JsonObject },
  runtimeMode: RuntimeMode,
) {
  const next = structuredClone(manifest);

  if (runtimeMode === "wasm") {
    stampWasmService(next, "api", "oci://registry.example.com/multi-cloud-shop-api@sha256:abc123", 8080);
    stampWasmService(
      next,
      "frontend",
      "oci://registry.example.com/multi-cloud-shop-frontend@sha256:def456",
      3000,
    );
  } else {
    stampContainerService(next, "api", "ghcr.io/acme/multi-cloud-shop-api:1.4.0", "services/api", 8080);
    stampContainerService(
      next,
      "frontend",
      "ghcr.io/acme/multi-cloud-shop-frontend:1.4.0",
      "services/frontend",
      3000,
    );
  }

  return next;
}

export function swapRuntimeMode(
  manifest: { schema: string; resources: JsonObject },
  runtimeMode: RuntimeMode,
) {
  return applyRuntimeArtifacts(manifest, runtimeMode);
}

export function projectWiringSurface(
  manifest: { resources: JsonObject },
  serviceId: string,
  configEntries: ConfigEntry[] = defaultMultiCloudShopConfig(),
): WiringProjection {
  const resource = manifest.resources[serviceId];
  if (!resource || !isJsonObject(resource)) {
    throw new WiringParityError(`resources.${serviceId}`, "missing service resource");
  }

  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = resource as JsonObject;
  const env = isRecord(record.env) ? { ...record.env } : {};
  const bindings = isRecord(record.bindings)
    ? structuredClone(
        // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
        record.bindings as Record<string, { port: string; resource: string; clientType: string }>,
      )
    : {};

  const rawLinks = Array.isArray(record.links) ? record.links : [];
  const links = rawLinks.map((link) => {
    const entry: { import?: JsonValue; to?: JsonValue } =
      // SAFETY: manifest links are { import, to } objects after array parse.
      link as never;
    return {
      import: isJsonString(entry.import) ? entry.import : "",
      to: isJsonString(entry.to) ? entry.to : "",
    };
  });

  return {
    links: sortLinks(links),
    env: sortRecord(stripRuntimeOnlyEnv(env)),
    config: sortRecord(
      Object.fromEntries(
        configEntries
          .filter((entry) => entry.key in env)
          .map((entry) => [entry.key, env[entry.key]]),
      ),
    ),
    bindings: sortRecord(bindings),
  };
}

export function assertWiringParity(
  left: { resources: JsonObject },
  right: { resources: JsonObject },
  serviceIds: string[],
  configEntries: ConfigEntry[] = defaultMultiCloudShopConfig(),
) {
  for (const serviceId of serviceIds) {
    const leftWiring = projectWiringSurface(left, serviceId, configEntries);
    const rightWiring = projectWiringSurface(right, serviceId, configEntries);
    assertDeepEqual(leftWiring, rightWiring, `resources.${serviceId}.wiring`);
  }

  return { ok: true as const, services: serviceIds };
}

export function runContainerFallbackWiringConformance(
  options: {
    fixture?: string;
    wasmManifest?: { schema: string; resources: JsonObject };
    containerManifest?: { schema: string; resources: JsonObject };
  } = {},
) {
  const fixture = options.fixture ?? MULTI_CLOUD_SHOP_FIXTURE;
  const wasmManifest = options.wasmManifest ?? createMultiCloudShopWiringFixture("wasm");
  const containerManifest =
    options.containerManifest ?? createMultiCloudShopWiringFixture("container");

  validateManifest(withComponentHost(wasmManifest));
  validateManifest(withComponentHost(containerManifest));

  const services = ["api", "frontend"];
  assertWiringParity(wasmManifest, containerManifest, services);
  assertManifestWiringUnchangedOnRuntimeSwap(wasmManifest, "container");
  assertManifestWiringUnchangedOnRuntimeSwap(containerManifest, "wasm");

  return {
    ok: true,
    schema: WIRING_PARITY_SCHEMA,
    fixture,
    services,
    assertions: [
      "bind-links-match",
      "connection-strings-match",
      "services-endpoint-env-match",
      "ctx-config-tokens-match",
      "runtime-swap-zero-manifest-edits",
    ],
  };
}

export function assertManifestWiringUnchangedOnRuntimeSwap(
  manifest: { schema: string; resources: JsonObject },
  targetRuntime: RuntimeMode,
) {
  const wiringSnapshot = Object.fromEntries(
    ["api", "frontend"].map((serviceId) => [
      serviceId,
      projectWiringSurface(manifest, serviceId),
    ]),
  );

  const swapped = swapRuntimeMode(manifest, targetRuntime);

  for (const serviceId of ["api", "frontend"]) {
    const after = projectWiringSurface(swapped, serviceId);
    assertDeepEqual(wiringSnapshot[serviceId], after, `swap.${serviceId}.wiring`);
  }

  for (const [serviceId, resource] of Object.entries(manifest.resources)) {
    if (!isRecord(resource)) {
      continue;
    }
    for (const [key, value] of Object.entries(resource)) {
      if (RUNTIME_SPECIFIC_KEYS.has(key)) {
        continue;
      }
      const swappedResource = swapped.resources[serviceId];
      if (!isRecord(swappedResource)) {
        continue;
      }
      if (JSON.stringify(value) !== JSON.stringify(swappedResource[key])) {
        throw new WiringParityError(
          `resources.${serviceId}.${key}`,
          "runtime swap changed non-runtime manifest field",
        );
      }
    }
  }

  return swapped;
}

function stampWasmService(
  manifest: { resources: JsonObject },
  serviceName: string,
  image: string,
  port: number,
) {
  const resource = requireService(manifest, serviceName);
  resource.runtime = "wasm";
  resource.exports = ["wasi:http/incoming-handler"];
  resource.image = image;
  delete resource.build;
  injectAspireEndpointEnv(resource, serviceName, "http", port);
}

function stampContainerService(
  manifest: { resources: JsonObject },
  serviceName: string,
  image: string,
  source: string,
  port: number,
) {
  const resource = requireService(manifest, serviceName);
  resource.runtime = "container";
  resource.image = image;
  resource.build = {
    provider: "hobo:build-dagger",
    source,
    fallbackReason: "declared-runtime: container",
  };
  delete resource.exports;
  injectAspireEndpointEnv(resource, serviceName, "http", port);
}

function defaultMultiCloudShopConfig(): ConfigEntry[] {
  return [
    { key: "SHOP_REGION", source: { kind: "camp-env", ref: "region" }, required: true },
    { key: "FEATURE_CHECKOUT", source: { kind: "camp-env", ref: "flags.checkout" } },
    { key: "ORDERS_DB", source: { kind: "binding", ref: "orders" }, required: true },
    { key: "ASSETS_STORE", source: { kind: "binding", ref: "assets" } },
    { key: "STRIPE_KEY", source: { kind: "secret-ref", ref: "stripe/api-key" }, required: true },
  ];
}

function injectConfigEnv(resource: JsonObject, configEntries: ConfigEntry[]) {
  resource.env ??= {};
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const env = resource.env as Record<string, string>;
  for (const entry of configEntries) {
    env[entry.key] = configTokenForEntry(entry);
  }
}

function configTokenForEntry(entry: ConfigEntry): string {
  switch (entry.source.kind) {
    case "binding":
      return `{${entry.source.ref}.connectionString}`;
    case "secret-ref":
      return `{secret.${entry.source.ref}}`;
    case "camp-env":
      return `\${context.${entry.source.ref}}`;
    default:
      throw new WiringParityError(`config.${entry.key}`, "unsupported config source");
  }
}

function injectAspireEndpointEnv(
  resource: JsonObject,
  serviceName: string,
  endpointName: string,
  port: number,
) {
  resource.env ??= {};
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const env = resource.env as Record<string, string>;
  env[aspireServiceEndpointKey(serviceName, endpointName)] =
    `{${serviceName}.endpoints.${endpointName}.url}`;
  env[aspireServiceEndpointKey(serviceName, endpointName, 1)] = String(port);
}

function stripRuntimeOnlyEnv(env: Record<string, string>) {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    next[key] = value;
  }
  return next;
}

function requireService(manifest: { resources: JsonObject }, serviceName: string) {
  const resource = manifest.resources[serviceName];
  if (!isRecord(resource)) {
    throw new WiringParityError(`resources.${serviceName}`, "missing service resource");
  }
  return resource;
}

function withComponentHost(manifest: { schema: string; resources: JsonObject }) {
  return {
    ...manifest,
    componentHost: {
      kind: "component-host",
      version: "0.2.0",
    },
  };
}

function sortLinks(links: Array<{ import: string; to: string }>) {
  return [...links].sort((left, right) =>
    `${left.import}:${left.to}`.localeCompare(`${right.import}:${right.to}`),
  );
}

function sortRecord<T extends JsonObject>(record: T): T {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]]),
  ) as T;
}

function assertDeepEqual(actual: JsonValue, expected: JsonValue, path: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new WiringParityError(path, "wiring surfaces diverged");
  }
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}
