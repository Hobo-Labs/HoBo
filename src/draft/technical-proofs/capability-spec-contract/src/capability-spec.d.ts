import { type JsonValue, type JsonObject } from "./json.js";
export type StabilityTier = "stable" | "preview" | "experimental" | "deprecated";
export type AvailabilityStatus = "ok" | "warn" | "error";

export interface ArtifactRef {
  mediaType: string;
  uri: `oci://${string}@${string}`;
  digest: `sha256:${string}`;
}

export interface CapabilityProviderRef {
  id: string;
  name: string;
  version: string;
}

export interface ConformanceReportRef {
  suite: string;
  suiteVersion: string;
  ref: ArtifactRef;
}

export interface CapabilityDeclaration {
  interface: string;
  semver: string;
  stability: StabilityTier;
  conformanceSuite: string;
  conformanceSuiteVersion: string;
  conformanceReportRef: ArtifactRef;
}

export interface CapabilitySpec {
  schema: "hobo.capability-spec/v1";
  provider: CapabilityProviderRef;
  costFactsRef?: ArtifactRef;
  capabilityHints?: JsonObject;
  reports: ConformanceReportRef[];
  interfaces: CapabilityDeclaration[];
}

export interface ParseCapabilitySpecResult {
  ok: boolean;
  errors: string[];
  spec: CapabilitySpec | null;
}

export interface AvailabilityResult {
  requested: string;
  status: AvailabilityStatus;
  message: string;
  remediation?: string;
  providerId?: string;
  providerName?: string;
  interface?: string;
  semver?: string;
  stability?: StabilityTier;
  conformanceSuiteVersion?: string;
}

export interface AvailabilityResolution {
  status: AvailabilityStatus;
  results: AvailabilityResult[];
}

export const CAPABILITY_SPEC_SCHEMA: "hobo.capability-spec/v1";
export const STABILITY_TIERS: readonly StabilityTier[];

export function createFixtureCapabilitySpec(input?: {
  providerId?: string;
  providerName?: string;
  providerVersion?: string;
  interfaces?: Array<{
    interface: string;
    semver: string;
    stability: StabilityTier;
    suite: string;
    suiteVersion: string;
  }>;
}): CapabilitySpec;

export function parseCapabilitySpec(candidate: JsonValue): ParseCapabilitySpecResult;
export function resolveAvailability(
  usedInterfaces: string[],
  registeredSpecs: JsonValue[]
): AvailabilityResolution;
export function parseUsedInterfaceRef(ref: string): { ref: string; interface: string; semver: string } | null;
