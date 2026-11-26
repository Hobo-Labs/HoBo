import { type JsonValue } from "./json.js";
export declare const REGISTRY_PUBLISH_FLOW_CONTRACT: "hobo.registry-publish-flow/v1";

export interface RegistryPublishFlow {
  publish(input: PublishInput): PublishResult;
  events(): RegistryListingEvent[];
  catalog(): RegistryPublishCatalog;
  ociStore(): RegistryPublishOciStore;
}

export interface RegistryPublishCatalog {
  certified(): RegistryListing[];
  publishedOnly(): RegistryListing[];
  history(coordinate: ListingCoordinate): RegistryListing[];
  current(coordinate: ListingCoordinate): RegistryListing | null;
  get(listingId: string): RegistryListing | null;
}

export interface PublishInput {
  descriptor: JsonValue;
  signedArtifact: JsonValue;
  trustBoundary: JsonValue;
  conformanceReports: ConformanceReport[];
  occurredAt: string;
}

export interface PublishResult {
  ok: boolean;
  contract: typeof REGISTRY_PUBLISH_FLOW_CONTRACT;
  status: "Rejected" | "Published" | "Certified";
  reasons: string[];
  listing: RegistryListing | null;
}

export interface ListingCoordinate {
  name: string;
  version: string;
}

export interface RegistryListing {
  contract: typeof REGISTRY_PUBLISH_FLOW_CONTRACT;
  listingId: string;
  status: "Published" | "Certified";
  kind: string;
  name: string;
  version: string;
  artifact: ArtifactRef;
  descriptor: JsonValue;
  publisher: JsonValue;
  storageRef: ArtifactRef;
  signature: ListingSignature;
  provenanceRef: ArtifactRef;
  builderId: string;
  occurredAt: string;
  previousListingId: string | null;
  certification: ListingCertification | null;
}

export interface RegistryPublishOciStore {
  push(input: StorePushInput): StorePushResult;
  resolve(coordinate: ListingCoordinate): string | null;
  entriesFor(coordinate: ListingCoordinate): StoreEntry[];
  get(digest: string): StoreEntry | null;
}

export interface StorePushInput {
  descriptor: JsonValue;
  signedArtifact: JsonValue;
}

export interface StorePushResult {
  digest: string;
  descriptorRef: ArtifactRef;
  artifactRef: ArtifactRef;
  name: string;
  version: string;
  previousDigest: string | null;
  idempotent: boolean;
}

export interface StoreEntry {
  digest: string;
  coordinate: ListingCoordinate;
  descriptorRef: ArtifactRef;
  artifactRef: ArtifactRef;
  signature: ListingSignature;
  previousDigest: string | null;
}

export interface ConformanceReport {
  suite: string;
  suiteVersion: string;
  status?: "passed" | "failed";
  passed?: boolean;
  stability?: "stable" | "preview" | "experimental" | "deprecated";
  ref: ArtifactRef;
}

export interface ArtifactRef {
  mediaType: string;
  uri: string;
  digest: string;
}

export interface ListingSignature {
  alg: string;
  keyId: string;
  payloadDigest: string;
}

export interface ListingCertification {
  status: "passed";
  reportRefs: ArtifactRef[];
}

export type RegistryListingEvent = ListingPublishedEvent | ListingCertifiedEvent;

export interface ListingPublishedEvent {
  type: "listing.Published";
  contract: typeof REGISTRY_PUBLISH_FLOW_CONTRACT;
  seq: number;
  listingId: string;
}

export interface ListingCertifiedEvent {
  type: "listing.Certified";
  contract: typeof REGISTRY_PUBLISH_FLOW_CONTRACT;
  seq: number;
  listingId: string;
}

export declare function createInMemoryPublishArtifactStore(options?: {
  registry?: string;
  namespace?: string;
}): RegistryPublishOciStore;

export declare function createRegistryPublishFlow(options?: {
  ociStore?: RegistryPublishOciStore;
}): RegistryPublishFlow;
