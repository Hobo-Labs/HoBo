export const CLOUDFLARE_PROVIDER_TARGET = "cloudflare";

interface OptionBlockOptions {
	cpuMs?: number;
	memoryMb?: number;
	scriptSizeMb?: number;
	compatibilityDate?: string;
	jurisdiction?: string;
	s3Compatibility?: string;
	publicAccess?: boolean;
	ttlSeconds?: number;
	eventualConsistency?: boolean;
}

export interface TypedOptionBlock {
  providerId: string;
  port: string;
  optionName: string;
  negotiation: "prefer" | "require";
  options: OptionBlockOptions;
}

export const cloudflare = {
  with: {
    worker(options: OptionBlockOptions = {}): TypedOptionBlock {
      return optionBlock("compute", "worker", {
        compatibilityDate: "2026-01-01",
        cpuMs: 10_000,
        memoryMb: 128,
        scriptSizeMb: 3,
      }, options);
    },
    r2(options: OptionBlockOptions = {}): TypedOptionBlock {
      return optionBlock("objectStore", "r2", {
        jurisdiction: "auto",
        s3Compatibility: "aws-sdk-v3-basic",
        publicAccess: false,
      }, options);
    },
    kv(options: OptionBlockOptions = {}): TypedOptionBlock {
      return optionBlock("kv", "kv", {
        ttlSeconds: 0,
        eventualConsistency: true,
      }, options);
    },
  },
};

// parallel-type-allowed: draft domain view; the wire contract remains data-models/hello-bindle.proto.
export interface HelloBindleResource {
  id: string;
  type: string;
  className: string;
  require: string[];
  colo: string;
  options: TypedOptionBlock[];
  build?: {
    artifactId: string;
    source: string;
    target: string;
  };
  binds?: Array<{
    import: string;
    providerResourceId: string;
    capability: string;
  }>;
}

// parallel-type-allowed: draft domain view; the wire contract remains data-models/hello-bindle.proto.
export interface HelloBindlePlan {
  id: string;
  context: {
    app: string;
    env: string;
    envType: string;
    provider: string;
    colo: string;
  };
  resources: HelloBindleResource[];
}

export interface HelloBindlePlanOptions {
  id?: string;
  env?: string;
  colo?: string;
}

export function createHelloBindlePlan(options: HelloBindlePlanOptions = {}): HelloBindlePlan {
  const colo = options.colo ?? "WNAM";
  return {
    id: options.id ?? "hello-bindle-cloudflare",
    context: {
      app: "hello-bindle",
      env: options.env ?? "preview",
      envType: "ephemeral",
      provider: "@hobo/provider-cloudflare",
      colo,
    },
    resources: [
      {
        id: "service",
        type: "compute",
        className: "worker",
        require: ["edge", "worker", "wasm-native", "http"],
        colo,
        options: [cloudflare.with.worker({ cpuMs: 10_000 })],
        build: {
          artifactId: "hello-bindle-wasm",
          source: "examples/hello-bindle",
          target: "wasm-component",
        },
        binds: [
          { import: "wasi:blobstore/blobstore", providerResourceId: "assets", capability: "objectStore" },
          { import: "hobo:kv/store", providerResourceId: "sessions", capability: "kv" },
        ],
      },
      {
        id: "assets",
        type: "objectStore",
        className: "bucket",
        require: ["durable", "s3-compatible"],
        colo,
        options: [cloudflare.with.r2({ publicAccess: false })],
      },
      {
        id: "sessions",
        type: "kv",
        className: "namespace",
        require: ["eventual", "edge"],
        colo,
        options: [cloudflare.with.kv({ ttlSeconds: 3600 })],
      },
    ],
  };
}

function optionBlock(
  port: string,
  builder: string,
  defaults: OptionBlockOptions,
  options: OptionBlockOptions,
): TypedOptionBlock {
  return {
    providerId: CLOUDFLARE_PROVIDER_TARGET,
    port,
    optionName: builder,
    negotiation: "prefer",
    options: { ...defaults, ...options },
  };
}
