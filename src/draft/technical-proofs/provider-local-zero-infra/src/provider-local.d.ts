import { type JsonValue } from "./json.js";
export const PROVIDER_LOCAL_VERSION: "hobo.provider-local/v1";

export const local: {
  with: {
    database(options?: { engine?: string; name?: string; version?: string }): {
      port: "database";
      engine: string;
      name: string;
      version: string;
      fidelity: "local";
    };
    objectStore(options?: { name?: string }): {
      port: "objectStore";
      driver: "filesystem";
      name: string;
      fidelity: "local";
    };
    compute(options?: { runtime?: string; image?: string }): {
      port: "compute";
      runtime: string;
      image?: string;
      fidelity: "local";
    };
    queue(options?: { mode?: string }): {
      port: "queue";
      mode: string;
      fidelity: "mock";
    };
  };
};

export function createLocalProvider(options?: { root?: string }): {
  id: "@hobo/provider-local";
  apiVersion: "hobo.provider-local/v1";
  root: string;
  capabilities: Array<{ port: string; backend: string; fidelity: "local" | "mock" }>;
  with: typeof local.with;
  registerDefaultDefinitions(registry: JsonValue[]): JsonValue[];
  capabilityManifest(): JsonValue;
  realize(plan: JsonValue): JsonValue;
  client(port: string, outputs: JsonValue): JsonValue;
};

export function createProviderLocalFixturePlan(): JsonValue;
export function runLocalProviderConformance(provider: ReturnType<typeof createLocalProvider>): { ok: true; checked: string[] };
export function createLocalRuntime(options: { root: string }): {
  provision(emission: JsonValue, options?: { holdMs?: number }): Promise<JsonValue>;
  destroy(deploymentId: string): Promise<{ deploymentId: string; residue: boolean; remaining: string[] }>;
};
