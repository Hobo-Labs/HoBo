// @hobo/registry — the Registry catalog service.
//
// The catalog engine (provider registration/approval facts, the event-backed
// planner registry fold, and the registry-catalog projection) lives in
// @hobo/cloud; this package re-exposes it unduplicated and adds the missing
// thirds: bundle-manifest ingest, fail-closed signature/provenance
// verification, and a deterministic in-memory search index.

// Catalog engine, wrapped from @hobo/cloud (never reimplemented here).
export {
	approveProviderFact,
	createEventBackedRegistry,
	createRegistryFromProviders,
	definitionsFor,
	type EventBackedRegistryDeps,
	foldRegistryStream,
	type HeldProvider,
	type PlannerRegistry,
	parseRegisteredDefinitions,
	type RegistrableCapability,
	type RegistrableProvider,
	type RegistryCatalogRow,
	type RegistryStreamFold,
	type ResourceDefinition,
	registerProviderFact,
	registryCatalogProjection,
} from "@hobo/cloud";
export {
	BUNDLE_MANIFEST_SCHEMA,
	type BundleCapability,
	type BundleImportedFact,
	type BundleManifest,
	bundleManifestDigest,
	type IngestError,
	type IngestErrorCode,
	type IngestResult,
	ingestBundleManifest,
	REGISTRY_BUNDLE_IMPORTED,
} from "./ingest.js";
export {
	PROVENANCE_STATEMENT_TYPE,
	type ProvenanceParseError,
	type ProvenanceParseErrorCode,
	type ProvenanceParseResult,
	type ProvenancePredicate,
	type ProvenanceStatement,
	type ProvenanceSubject,
	parseProvenanceStatement,
	type SignatureVerifier,
	SLSA_PROVENANCE_PREDICATE_TYPE,
	type VerificationResult,
	type VerifyBundleInput,
	verifyBundleProvenance,
} from "./provenance.js";
export {
	type BundleIndexEntry,
	type BundleSearchQuery,
	type RankedBundle,
	searchBundles,
	toIndexEntry,
} from "./search.js";
