// "@hobo/cd/freight" (WP1): the Freight ledger, the hobo.freight-manifest/v1
// boundary, deterministic ids and aliases, and the D18 retention decision.
export { ALIAS_ADJECTIVES, ALIAS_NOUNS, freightAlias } from "./alias.js";
export { createFreightLedger, FREIGHT_METRIC, type FreightLedgerDeps } from "./ledger.js";
export {
	ARTIFACT_ECOSYSTEMS,
	DIGEST_PATTERN,
	FreightManifestError,
	type FreightManifestInput,
	freightIdentity,
	parseFreightManifest,
	writeFreightManifest,
} from "./manifest.js";
export { FREIGHT_REASON, type FreightReasonCode } from "./reasons.js";
export {
	type CampDeployments,
	LEGAL_HOLD_LABEL,
	planRetention,
	type RetentionCandidate,
	type RetentionInput,
	type RetentionKeepReason,
	type RetentionPin,
	type RetentionPlan,
	type RetentionPolicy,
} from "./retention.js";
