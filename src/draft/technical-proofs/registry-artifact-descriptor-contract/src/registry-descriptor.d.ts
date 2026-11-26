import { type JsonValue } from "./json.js";
export type ListingKind =
  | "provider"
  | "resource-pack"
  | "policy-pack"
  | "agent-skill"
  | "runbook"
  | "hobo-code-module"
  | "bindle"
  | "camp"
  | "yard"
  | "junction";

export type StabilityTier = "stable" | "preview" | "experimental" | "deprecated";

export interface ArtifactRef {
  mediaType: string;
  uri: `oci://${string}@${string}`;
  digest: `sha256:${string}`;
}

export interface PublisherRef {
  type: string;
  id: string;
  trustDomain?: string;
}

export interface InterfaceTriple {
  interface: string;
  semver: string;
  stability: StabilityTier;
}

export interface InterfaceDeclaration {
  ref: string;
  conformanceSuite: string;
  conformanceSuiteVersion: string;
  conformanceReportRef: ArtifactRef;
}

export interface ConformanceReportRef {
  suite: string;
  suiteVersion: string;
  ref: ArtifactRef;
}

export interface RegistryDescriptor {
  schema: "registry.descriptor/v1";
  kind: ListingKind;
  name: string;
  version: string;
  artifact: ArtifactRef;
  publisher: PublisherRef;
  evidence: {
    slsaProvenanceRef: ArtifactRef;
    conformanceReportRefs: ConformanceReportRef[];
  };
  interfaces: {
    exports: InterfaceDeclaration[];
    imports: InterfaceDeclaration[];
  };
}

export interface ParseDescriptorResult {
  ok: boolean;
  errors: string[];
  descriptor: RegistryDescriptor | null;
  parsedInterfaces: {
    exports: InterfaceTriple[];
    imports: InterfaceTriple[];
  };
}

export const REGISTRY_DESCRIPTOR_SCHEMA: "registry.descriptor/v1";
export const LISTING_KINDS: readonly ListingKind[];
export const STABILITY_TIERS: readonly StabilityTier[];

export function createFixtureDescriptor(input?: { kind?: ListingKind }): RegistryDescriptor;
export function parseDescriptor(candidate: JsonValue): ParseDescriptorResult;
export function serializeDescriptor(descriptor: RegistryDescriptor): string;
export function deserializeDescriptor(text: string): ParseDescriptorResult;
export function canonicalJson(value: JsonValue): string;
export function parseInterfaceRef(ref: string): InterfaceTriple | null;
