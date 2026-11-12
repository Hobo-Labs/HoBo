/**
 * `@hobo/secret-store-claim` — the `secrets.config-service/v1` capability,
 * chosen when a HoBo deployment runs and handed to its owner by claim
 * (ADR-0179 amendment "Secret store chosen at deploy, provisioned by claim").
 */
export type {
	SecretStoreBinding,
	SecretStoreEvidence,
	SecretStoreOffer,
	SecretStoreSelection,
} from "./_generated/secret_store_claim_pb.js";
export {
	SecretStoreBindingSchema,
	SecretStoreEvidenceSchema,
	SecretStoreOfferSchema,
	SecretStoreSelectionSchema,
} from "./_generated/secret_store_claim_pb.js";
export {
	AUTH_MD_PROVIDER_ID,
	probeAuthMdStore,
	provisionAuthMdStore,
} from "./auth-md.js";
export {
	formatSecretStoreBinding,
	type ParsedSecretStoreBinding,
	parseSecretStoreBinding,
	readSecretStoreBinding,
	SECRET_STORE_BINDING_FILE,
} from "./binding.js";
export {
	type ClaimScope,
	claimScopeFor,
	SECRET_STORE_CLAIM_ITEM,
	sealClaimAction,
	secretStoreBundleId,
	secretStoreClaimBundle,
	secretStoreClaimItem,
} from "./claim.js";
export {
	CLOUDFLARE_PROVIDER_ID,
	type CloudflareStoreReceipt,
	provisionCloudflareTemporaryStore,
} from "./cloudflare.js";
export {
	SECRET_STORE_ERROR_CODES,
	SecretStoreError,
	type SecretStoreErrorCode,
} from "./errors.js";
export {
	attachInfisicalCloud,
	provisionSelfHostedInfisical,
	type RelayStoreLayout,
	relayStoreLayout,
	SELF_HOSTED_PROVIDER_ID,
	verifySelfHostedInfisicalClaim,
} from "./infisical.js";
export {
	CLAIM_MECHANISMS,
	type ClaimMechanism,
	DEFAULT_SECRET_STORE_OFFERS,
	type ParsedSecretStoreOffer,
	parseSecretStoreKind,
	parseSecretStoreOffer,
	SECRET_STORE_CAPABILITY,
	SECRET_STORE_KINDS,
	type SecretStoreKind,
} from "./offers.js";
export {
	type ParsedSecretStoreEvidence,
	parseSecretStoreEvidence,
	type SecretStoreRoute,
	selectSecretStore,
} from "./select.js";
