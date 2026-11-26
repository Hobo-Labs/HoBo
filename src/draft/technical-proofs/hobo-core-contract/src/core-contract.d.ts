import { type JsonObject } from "./json.js";
export type PrincipalKind = "user" | "agent" | "service" | "system";
export type PortKind = "runtime" | "provider" | "port";
export type InterfaceStability = "stable" | "preview" | "experimental";

export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
  delegatedBy?: PrincipalRef;
}

export interface PortDescriptor {
  kind: PortKind;
  name: string;
  interface: string;
  stability: InterfaceStability;
}

export interface RuntimePort extends PortDescriptor {
  kind: "runtime";
}

export interface ProviderPort extends PortDescriptor {
  kind: "provider";
}

export interface EventEnvelope<T = unknown> {
  id: string;
  type: string;
  v: number;
  streamId: string;
  seq: number;
  ts: string;
  actor: PrincipalRef;
  tenant: string;
  project?: string;
  causationId?: string;
  correlationId?: string;
  data: T;
  lane?: string;
  meta?: JsonObject;
}

export interface CapabilityManifestBundle {
  index: {
    schemaVersion: "hobo.core/v1";
    issuer: string;
    manifestDigest: string;
    signature: {
      alg: "HOBO-FIXTURE-SHA256";
      keyId: string;
      digest: string;
    };
    files: string[];
  };
  capabilities: {
    ports: Array<{ port: string; kinds: string[]; stability: InterfaceStability }>;
    regions: string[];
    equivalenceClasses: string[];
  };
  auth: {
    issuer: string;
    flows: Array<JsonObject>;
    scopeModel: string;
    resourceIndicators: string[];
    tokenLifetimeSec: number;
    audit: { events: string[] };
  };
  cost: JsonObject;
}

export interface Container {
  register<T>(descriptor: PortDescriptor, implementation: T): void;
  resolve<T>(descriptor: PortDescriptor): T;
}
