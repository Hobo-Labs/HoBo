export type AdapterKind = "npm" | "nuget" | "pypi" | "oci" | "maven" | "cargo" | "rubygems";

export interface ArtifactCoordinate {
  ecosystem: AdapterKind;
  name: string;
  version: string;
}

export interface ArtifactRef {
  mediaType: string;
  uri: `oci://${string}@sha256:${string}`;
  digest: `sha256:${string}`;
}

export type ProvenanceRef = ArtifactRef;

export interface VerifiedArtifact {
  adapterId: string;
  coordinate: ArtifactCoordinate;
  artifact: ArtifactRef;
  verification: {
    digestPinned: true;
  };
}

export interface ArtifactRepoPort {
  id: string;
  kind: AdapterKind;
  pull(coordinate: ArtifactCoordinate): Promise<ArtifactRef | { artifact: ArtifactRef }>;
  publish(input: { artifact: ArtifactRef; provenance: ProvenanceRef }): Promise<ArtifactRef | { artifact: ArtifactRef }>;
}

export interface MirrorSet {
  name: string;
  adapters: readonly ArtifactRepoPort[];
}

export interface ArtifactRepoRegistry {
  registerAdapter(adapter: ArtifactRepoPort): ArtifactRepoPort;
  getAdapter(id: string): ArtifactRepoPort | undefined;
  hasAdapter(adapter: ArtifactRepoPort): boolean;
  listAdapters(): ArtifactRepoPort[];
}

export interface ConformanceReport {
  adapterId: string;
  ok: boolean;
  failures: string[];
}

export const ARTIFACT_REPO_WIT_PACKAGE: "hobo:artifact-repo@0.1.0";
export const ADAPTER_KINDS: readonly AdapterKind[];

export function createDigestArtifactRef(seed: string, options?: { mediaType?: string }): ArtifactRef;
export function createArtifactRepoRegistry(): ArtifactRepoRegistry;
export function createInMemoryArtifactRepoAdapter(input: {
  id: string;
  kind: AdapterKind;
  artifacts?: Record<string, ArtifactRef>;
}): ArtifactRepoPort & { published: Array<{ artifact: ArtifactRef; provenance: ProvenanceRef; ref: ArtifactRef }> };
export function defineMirrorSet(registry: ArtifactRepoRegistry, input: {
  name: string;
  adapters: Array<string | ArtifactRepoPort>;
}): MirrorSet;
export function pullArtifact(mirrorSet: MirrorSet, coordinate: ArtifactCoordinate): Promise<VerifiedArtifact>;
export function publishArtifact(adapter: ArtifactRepoPort, input: {
  artifact: ArtifactRef;
  provenance: ProvenanceRef;
}): Promise<ArtifactRef>;
export function runArtifactRepoConformance(adapter: ArtifactRepoPort, input: {
  coordinate: ArtifactCoordinate;
}): Promise<ConformanceReport>;
