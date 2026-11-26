import { type JsonValue } from "./json.js";
export declare const MTLS_DATA_PATH_SCHEMA_VERSION: "hobo.mtls-data-path/v1";

export interface WorkloadSpiffeIdentity {
  trustDomain: string;
  tenant: string;
  bindle: string;
  resource: string;
}

export interface PeerCertificate {
  spiffeId: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  rotationEpoch: number;
}

export interface MtlsDataPathContract {
  schemaVersion: typeof MTLS_DATA_PATH_SCHEMA_VERSION;
  connectionId: string;
  tenant: string;
  trustDomain: string;
  sourceSvid: string;
  peerCertificate: PeerCertificate;
  allowedPeers: string[];
  certMaterialRef: string;
  minimumPeerRotationEpoch?: number;
  authz: {
    bindEdgeId: string;
    verbs: string[];
  };
  now?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export type MtlsHandshakeDecision =
  | {
      ok: true;
      connectionId: string;
      source: WorkloadSpiffeIdentity;
      peer: WorkloadSpiffeIdentity;
      authz: MtlsDataPathContract["authz"];
      certMaterialRef: string;
    }
  | { ok: false; code: string; reason: string };

export declare function parseWorkloadSpiffeId(
  input: string,
  options?: { expectedTenant?: string; expectedTrustDomain?: string },
): WorkloadSpiffeIdentity;

export declare function validateMtlsDataPathContract(contract: JsonValue): ValidationResult;

export declare function evaluateMtlsHandshake(contract: MtlsDataPathContract): MtlsHandshakeDecision;
