import { type JsonValue, type JsonObject } from "./json.js";
export type BrokerArtifactKind =
  | "contract-manifest"
  | "broker-environment"
  | "mapping-contract"
  | "broker-catalog-snapshot"
  | "resolution-receipt"
  | "resolution-rejection";

// domain-view: parse-produced draft-proof record; its wire form is the BrokerArtifactEnvelope proto message in data-models/.
export interface BrokerArtifactEnvelope<TPayload = JsonObject> {
  kind: BrokerArtifactKind;
  schema: string;
  version: string;
  owner: string;
  provenance: BrokerArtifactProvenance;
  payload: TPayload;
}

// domain-view: parse-produced draft-proof record; its wire form is the BrokerArtifactProvenance proto message in data-models/.
export interface BrokerArtifactProvenance {
  source: {
    issue: string;
    refs: string[];
  };
  proofMode: "schema-test" | "contract-test" | "negative-test" | "policy-fixture";
  signature: {
    issuer: string;
    algorithm: "ed25519";
    digest: string;
  };
}

export declare const BROKER_ARTIFACT_SCHEMAS: Record<BrokerArtifactKind, string>;
export declare function createAcceptedBrokerFixture(): { artifacts: BrokerArtifactEnvelope[] };
export declare function createRejectionBrokerFixture(
  reason: "unsupported-capability" | "stale-catalog-snapshot" | "incompatible-mapping" | "ambiguous-mapping",
): { artifacts: BrokerArtifactEnvelope[] };
export declare function parseBrokerArtifactSet(input: JsonValue):
  | { ok: true; artifacts: BrokerArtifactEnvelope[]; errors: [] }
  | { ok: false; artifacts: []; errors: string[] };
export declare function evaluateBrokerArtifacts(artifacts: BrokerArtifactEnvelope[]): JsonValue;
export declare function stableDigest(value: JsonValue): string;
