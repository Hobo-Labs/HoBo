export {
	type RelayOwnerCredential,
	type RelayOwnerCredentialRequest,
	RelayOwnerCredentialRequestSchema,
	RelayOwnerCredentialSchema,
	type RelayOwnerDeviceAuthorization,
	RelayOwnerDeviceAuthorizationSchema,
	type RelayOwnerLoginError,
	RelayOwnerLoginErrorSchema,
	type RelayOwnerSession,
	RelayOwnerSessionSchema,
	type RelayOwnerTokenRequest,
	RelayOwnerTokenRequestSchema,
} from "./_generated/relay_owner_login_pb.js";

// public-contract: the path prefix of the relay's owner sign-in routes.
export const RELAY_OWNER_LOGIN_PREFIX = "/v1/owner-login/";
// public-contract: the relay route that starts the owner's device-code sign-in.
export const RELAY_OWNER_DEVICE_PATH = "/v1/owner-login/device";
// public-contract: the relay route a HoBo process polls for the owner's session.
export const RELAY_OWNER_TOKEN_PATH = "/v1/owner-login/token";
// public-contract: the relay route that resolves one credential locator for a signed-in session.
export const RELAY_OWNER_CREDENTIALS_PATH = "/v1/owner-login/credentials";
// public-contract: the owner-store entry a relay session resolves to a short-lived account credential.
export const RELAY_OWNER_ACCOUNT_CREDENTIAL = "owner://HOBO_CI_ACCOUNT_TOKEN";
// public-contract: how long a relay owner session lasts, in seconds.
export const RELAY_OWNER_SESSION_SECONDS = 8 * 60 * 60;
// public-contract: how long an account credential minted for a session lasts, in seconds.
export const RELAY_OWNER_ACCOUNT_CREDENTIAL_SECONDS = 15 * 60;
// public-contract: the least time a GitHub App installation token the relay hands out stays valid, in seconds.
export const RELAY_OWNER_INSTALLATION_TOKEN_SECONDS = 60;

export type RelayOwnerRefusal =
	| "authorization_pending"
	| "slow_down"
	| "access_denied"
	| "expired_token"
	| "invalid_request"
	| "not_owner"
	| "not_configured"
	| "device_flow_unavailable"
	| "session_required"
	| "not_resolvable"
	| "not_bound"
	| "github_refused";
