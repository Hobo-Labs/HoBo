import type { ProviderPort } from "@hobo/core";
import { createPortDescriptor } from "@hobo/core";
import type { JsonObject, JsonValue } from "./json.js";

export const IDENTITY_INTERFACE = "hobo:identity/provider";

export interface JsonWebKeySet {
	readonly keys: readonly JsonObject[];
}

// domain-view: the identity provider port shape adapters satisfy. Kept in this
// package (there is no identity port in @hobo/core) so gateways and the token
// broker depend on this contract rather than the concrete IdentityService — a
// SPIFFE JWT-SVID issuer with an OIDC discovery/JWKS surface.
export interface IdentityProvider {
	readonly issuerUrl: string;
	discovery(): JsonValue;
	jwks(): JsonWebKeySet;
	contractEvidence(): JsonValue;
}

// The provider-port descriptor for this boundary, built through @hobo/core so
// the identity service's only inward dependency is the shared port vocabulary.
const identityPortDescriptor = createPortDescriptor({
	kind: "provider",
	name: "identity",
	interface: IDENTITY_INTERFACE,
	stability: "preview",
});
// SAFETY: createPortDescriptor output is the identity ProviderPort at this boundary.
const IDENTITY_PORT = identityPortDescriptor as ProviderPort;

export { IDENTITY_PORT };
