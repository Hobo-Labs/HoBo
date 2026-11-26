import { type JsonValue } from "./json.js";
export interface ArtifactRef {
  mediaType: string;
  uri: string;
  digest: `sha256:${string}`;
}

export interface TransparencyProof {
  logId: string;
  logRoot: `sha256:${string}`;
  inclusionProof: ArtifactRef;
}

export interface RegistryBundleListing {
  kind: string;
  name: string;
  version: string;
  descriptor: ArtifactRef;
  buildTimestamp: string;
  provenance: ArtifactRef;
  conformanceReports: ArtifactRef[];
  transparency: TransparencyProof;
}

export interface RegistryBundleArtifact {
  name: string;
  artifact: ArtifactRef;
  buildTimestamp: string;
  provenance: ArtifactRef;
  transparency: TransparencyProof;
}

export interface RegistryBundleManifest {
  schema: "registry.bundle/v1";
  bundleId: string;
  version: string;
  createdAt: string;
  bundleDigest: `sha256:${string}`;
  curator: {
    id: string;
    trustDomain: string;
  };
  contents: {
    listings: RegistryBundleListing[];
    baseImages: RegistryBundleArtifact[];
    modelWeights?: RegistryBundleArtifact[];
  };
  trust: {
    revocationList: {
      issuedAt: string;
      expiresAt: string;
      signingKeyId: string;
      ref: ArtifactRef;
    };
    transparencyLog: {
      logId: string;
      pinnedRoot: `sha256:${string}`;
    };
    antiRollback: {
      yardId: string;
      stateEpoch: string;
    };
  };
}

export interface RegistryBundleImportedEvent {
  type: "registry.BundleImported";
  bundleDigest: `sha256:${string}`;
  importedAt: string;
  verification: {
    signature: "passed";
    provenance: "passed";
    conformance: "passed";
    revocation: "passed";
    antiRollback: "passed";
    transparency: "passed";
  };
  importedArtifacts: `sha256:${string}`[];
}

export interface ParseResult<T> {
  ok: boolean;
  errors: string[];
  manifest?: T | null;
  event?: T | null;
}

export function createFixtureBundle(): RegistryBundleManifest;
export function parseBundleManifest(candidate: JsonValue): ParseResult<RegistryBundleManifest> & {
  resolvedListings: Array<{
    name: string;
    kind: string;
    version: string;
    descriptorDigest: `sha256:${string}`;
  }>;
};
export function serializeBundleManifest(manifest: RegistryBundleManifest): string;
export function deserializeBundleManifest(text: string): ReturnType<typeof parseBundleManifest>;
export function parseBundleImportEvent(candidate: JsonValue): ParseResult<RegistryBundleImportedEvent>;
export function canonicalJson(value: JsonValue): string;
