import { type JsonObject } from "./json.js";
export const OCI_ARTIFACT_STORAGE_CONTRACT: "hobo.oci-artifact-storage/v1";

export interface ArtifactRef {
  mediaType: string;
  uri: string;
  digest: string;
}

export interface RegistryDescriptor {
  schema: string;
  kind: string;
  name: string;
  version: string;
  artifact: ArtifactRef;
  publisher: JsonObject;
  evidence: JsonObject;
  interfaces: {
    exports: Array<{ ref: string } & JsonObject>;
    imports: Array<{ ref: string } & JsonObject>;
  };
}

export interface ArtifactBytesInput {
  name: string;
  mediaType?: string;
  bytes: string | Uint8Array;
  registry?: string;
  namespace?: string;
}

export interface PushArtifactInput {
  mediaType?: string;
  bytes: string | Uint8Array;
}

export interface PushInput {
  descriptor: RegistryDescriptor;
  artifact: PushArtifactInput;
}

export interface PushResult {
  digest: string;
  descriptorRef: ArtifactRef;
  artifactRef: ArtifactRef;
  name: string;
  version: string;
  idempotent: boolean;
}

export interface PullResult {
  digest: string;
  descriptor: RegistryDescriptor;
  descriptorRef: ArtifactRef;
  descriptorBytes: Uint8Array;
  artifact: {
    ref: ArtifactRef;
    bytes: Uint8Array;
  };
}

export interface RegistryEvent {
  type: "ProviderRegistered" | "CapabilityManifestUpdated" | "RegistryListingPublished";
  contract: typeof OCI_ARTIFACT_STORAGE_CONTRACT;
  seq: number;
  name: string;
  version: string;
  kind: string;
  digest: string;
  descriptorRef?: ArtifactRef;
  artifactRef?: ArtifactRef;
  previousDigest?: string | null;
  exportedInterfaces?: string[];
  importedInterfaces?: string[];
}

export interface RegistryCatalogEntry {
  coordinateKey: string;
  name: string;
  version: string;
  kind: string;
  digest: string;
  descriptorRef: ArtifactRef;
  artifactRef: ArtifactRef;
  previousDigest: string | null;
  eventSeq: number;
}

export interface RegistryCatalogReadModel {
  all(): RegistryCatalogEntry[];
  entriesFor(coordinate: { name: string; version: string }): RegistryCatalogEntry[];
  resolve(coordinate: { name: string; version: string }): string | null;
}

export interface OciArtifactStore {
  push(input: PushInput): PushResult;
  pull(refOrDigest: string | { digest: string }): PullResult;
  resolve(coordinate: { name: string; version: string }): string;
  catalog(): RegistryCatalogReadModel;
  events(): RegistryEvent[];
  blobs(): Array<{
    digest: string;
    mediaType: string;
    bytes: Uint8Array;
    ref: ArtifactRef;
    role: "artifact" | "descriptor";
  }>;
}

export function createArtifactBytesRef(input: ArtifactBytesInput): ArtifactRef;

export function createOciArtifactStore(options?: {
  registry?: string;
  namespace?: string;
}): OciArtifactStore;
