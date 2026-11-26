export {
  ATTESTATION_SCHEMA_VERSION,
  createFixtureHostAttestor,
  verifyWorkloadAttestation,
  type AttestationDocument,
  type AttestationVerdict,
  type LaunchMeasurement,
  type PrincipalRef,
} from "./attestation.js";
export {
  createIdentityIssuedEvent,
  createIdentityRotatedEvent,
  CREDENTIAL_AUDIT_RETENTION,
  IDENTITY_EVENT_SCHEMA_VERSION,
  validateIdentityEvent,
  type IdentityEvent,
} from "./events.js";
export {
  createInMemoryKms,
  JwtSvidIssuer,
  JWT_ALGORITHM,
  verifyJwtWithJwks,
  type JwtSvidClaims,
  type KmsLike,
  type OidcDiscovery,
} from "./issuer.js";
export {
  IDENTITY_BOUNDARY_SCHEMA,
  IdentityService,
  type ActiveSvidRecord,
  type GatewayAuthResult,
  type IssueSvidResult,
  type RotateSvidResult,
  type ScopeEntry,
} from "./identity-service.js";
