import {
  MTLS_DATA_PATH_SCHEMA_VERSION,
  evaluateMtlsHandshake,
  type MtlsDataPathContract
} from "@hobo/draft-mtls-data-path-contract";

const contract: MtlsDataPathContract = {
  schemaVersion: MTLS_DATA_PATH_SCHEMA_VERSION,
  connectionId: "conn-shop-api-db",
  tenant: "tenant-acme",
  trustDomain: "yard",
  sourceSvid: "spiffe://yard/tenant-acme/shop/api",
  peerCertificate: {
    spiffeId: "spiffe://yard/tenant-acme/shop/db",
    serialNumber: "stub-cert-001",
    notBefore: "2026-06-28T11:55:00.000Z",
    notAfter: "2026-06-28T12:05:00.000Z",
    rotationEpoch: 1
  },
  allowedPeers: ["spiffe://yard/tenant-acme/shop/db"],
  certMaterialRef: "identity://svid-cert/tenant-acme/shop/api",
  minimumPeerRotationEpoch: 1,
  authz: {
    bindEdgeId: "shop.api->shop.db",
    verbs: ["connect"]
  },
  now: "2026-06-28T12:00:00.000Z"
};

const decision = evaluateMtlsHandshake(contract);

if (decision.ok) {
  decision.peer.resource satisfies string;
}
