import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG } from "../src/catalog.js";
import * as bindles from "../src/index.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../src/json.js";

const SNAPSHOT_VERSION = "hobo.bindles.public-api/v1";
const FORBIDDEN_PUBLIC_SYMBOL =
	/aws|azure|gcp|cloudflare|rds|fargate|cosmos|internal|cloud/i;

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"bindles-public-api.snapshot.json",
);

function allowUnion(verbs: readonly string[]): string {
	if (verbs.length === 0) return "never";
	return [...verbs]
		.sort((left, right) => left.localeCompare(right))
		.map((verb) => `"${verb}"`)
		.join(" | ");
}

export function createBindlesPublicApiSnapshot(
	module: typeof bindles = bindles,
): JsonObject {
	const factoryNames = CATALOG.map((entry) => entry.factory);
	const knownExports = new Set([
		"CATALOG",
		"catalogFactoryNames",
		"secretRef",
		"bindle",
		"DEFAULT_BINDLE_NAME",
		"inferRequirementsFromResources",
		"resourceIdentityLedger",
		"HOBO_BINDLES_PACKAGE",
		"MANIFEST_SCHEMA",
		"ManifestParseError",
		"aspireFallbackEnv",
		"canonicalManifestHash",
		"parseManifest",
		"parseManifestReference",
		"parseOutputPlaceholder",
		"serializeManifest",
		"addContainer",
		"bindingTypesFor",
		"BindReferenceError",
		"compileBindleManifest",
		"wiringData",
		"wiringService",
		"collectBindleManifest",
		"CollectionEngineError",
		"createCollectionEvents",
		"manifestFromWiring",
		"COLLECTION_EVENT_SOURCE",
		"env",
		"collectRequiredRuntimes",
		"DEPENDENCY_OPTION",
		"dependencyAnnotation",
		"dependencyRuntimeOf",
		"discoveryEnvForDependency",
		"discoveryEndpointsForDependency",
		"externalDependencyAnnotation",
		"containerDependencyAnnotation",
		"wasmComponentDependencyAnnotation",
		"isDependencyAnnotation",
		"readDependencyConfig",
		"assertNoBindleProviderSelection",
		"BINDLE_PROVIDER_SELECTION_FORBIDDEN",
		"BINDLE_PROVIDER_SELECTION_REMEDIATION",
		"collectExplicitProviderPins",
		"emptyBindleRequirements",
		"hashBindleRequirements",
		"isPlatformAnnotation",
		"parseBindleRequirements",
		"connectionRef",
		"requireConnection",
		"config",
		"envField",
		"fromBinding",
		"schemaOnlyView",
		"SECRET_SOURCE_RANKS",
		"secretField",
		"sourceRankIndex",
		"assertSourceAllowed",
		"generateCtxConfigSource",
		"evaluateSecretlessConfigGate",
		"evaluateBindingDeliveryGate",
		"isForbiddenSecretEnvKey",
		"looksLikeSecretEnvValue",
		"externalBoundaryViolations",
		"CONFIG_SENSITIVITY",
		"sensitivityForField",
		"BINDLE_FEATURES_SCHEMA",
		"declareExperiment",
		"features",
		"featureSpecsToStoreInputs",
		"rollout",
		"rolloutResource",
		"sessionReplay",
		"SESSION_REPLAY_OPTION",
		"isSessionReplayAnnotation",
		"defaultAppKitSessionReplayAnnotation",
		"statusPage",
		"STATUS_PAGE_OPTION",
		"isStatusPageAnnotation",
		"readStatusPageConfig",
		"APP_KIT_KINDS",
		"HTTP_APP_KIT_KINDS",
		"INFRA_KIT_KINDS",
		"appKitLabel",
		"isAppKitKind",
		"isHttpAppKitKind",
		"WEBAPP_OPTION",
		"WASP_WEBAPP_METADATA",
		"webAppAnnotationFromBinding",
		"isWebAppAnnotation",
		...factoryNames,
	]);

	const factoryExports = CATALOG.map((entry) => ({
		name: entry.factory,
		kind: "resource-factory",
		signature: `${entry.factory}(name: string): ResourceHandle<"${entry.factory}", ${allowUnion(entry.allowVerbs)}>`,
		portRef: [...entry.portRef],
		allowVerbs: [...entry.allowVerbs],
	}));

	const extraExports = Object.keys(module)
		.filter((name) => !knownExports.has(name))
		.sort((left, right) => left.localeCompare(right))
		.map((name) => ({
			name,
			kind: "unclassified-public-export",
			signature: `${name}: unknown`,
		}));

	return {
		package: "@hobo/bindles",
		version: SNAPSHOT_VERSION,
		resourceHandleSignature: {
			allow:
				"allow(...verbs: AllowVerb[]): ResourceHandle<Kind, NarrowedAllow>",
			descriptor: "toDescriptor(): ResourceDescriptor<Kind>",
			identity:
				"readonly identity: { kind: Kind; name: string; stableId: string }",
		},
		exports: [
			{
				name: "CATALOG",
				kind: "readonly-catalog",
				signature: "readonly ResourceCatalogEntry[]",
			},
			...factoryExports,
			{
				name: "catalogFactoryNames",
				kind: "catalog-helper",
				signature: "catalogFactoryNames(): ResourceKind[]",
			},
			{
				name: "secretRef",
				kind: "helper",
				signature: "secretRef(ref: string): SecretRef",
			},
			{
				name: "bindle",
				kind: "topology-builder",
				signature:
					"bindle(nameOrBuild: string | ((b: BindleBuilder) => Record<string, BindleResource>), …): BindleDefinition",
			},
			{
				name: "DEFAULT_BINDLE_NAME",
				kind: "package-constant",
				signature: 'const DEFAULT_BINDLE_NAME: "app"',
			},
			{
				name: "inferRequirementsFromResources",
				kind: "helper",
				signature:
					"inferRequirementsFromResources(resources: Readonly<Record<string, BindleResourceRecord>>): BindleRequirements",
			},
			{
				name: "resourceIdentityLedger",
				kind: "helper",
				signature:
					"resourceIdentityLedger(definition: BindleDefinition): ResourceIdentityLedger",
			},
			{
				name: "HOBO_BINDLES_PACKAGE",
				kind: "package-constant",
				signature: 'const HOBO_BINDLES_PACKAGE: "@hobo/bindles"',
			},
			{
				name: "MANIFEST_SCHEMA",
				kind: "manifest-constant",
				signature: 'const MANIFEST_SCHEMA: "hobo.manifest/v1"',
			},
			{
				name: "ManifestParseError",
				kind: "manifest-error",
				signature: "class ManifestParseError extends Error",
			},
			{
				name: "parseManifest",
				kind: "manifest-parser",
				signature: "parseManifest(input: JsonValue): ManifestV1",
			},
			{
				name: "serializeManifest",
				kind: "manifest-serializer",
				signature: "serializeManifest(manifest: ManifestV1): string",
			},
			{
				name: "canonicalManifestHash",
				kind: "manifest-hasher",
				signature: "canonicalManifestHash(manifest: ManifestV1): ManifestHash",
			},
			{
				name: "parseManifestReference",
				kind: "manifest-parser",
				signature: "parseManifestReference(value: string): ManifestReference",
			},
			{
				name: "parseOutputPlaceholder",
				kind: "manifest-parser",
				signature: "parseOutputPlaceholder(value: string): OutputPlaceholder",
			},
			{
				name: "aspireFallbackEnv",
				kind: "manifest-helper",
				signature:
					"aspireFallbackEnv(manifest: ManifestV1): Record<string, string[]>",
			},
			{
				name: "addContainer",
				kind: "wiring-factory",
				signature:
					"addContainer(name: string, source: string, options?: ContainerOptions): ComponentHandle",
			},
			{
				name: "bindingTypesFor",
				kind: "wiring-helper",
				signature:
					"bindingTypesFor(handle: ComponentHandle): Readonly<Record<string, string>>",
			},
			{
				name: "BindReferenceError",
				kind: "wiring-error",
				signature: "class BindReferenceError extends Error",
			},
			{
				name: "compileBindleManifest",
				kind: "wiring-compiler",
				signature:
					"compileBindleManifest(handles: readonly Handle[]): WiringManifest",
			},
			{
				name: "wiringData",
				kind: "wiring-factory",
				signature:
					"wiringData(name: string, options?: { paradigm?: string }): ResourceHandle",
			},
			{
				name: "wiringService",
				kind: "wiring-factory",
				signature:
					"wiringService(name: string, options?: ServiceOptions): ComponentHandle",
			},
			{
				name: "collectBindleManifest",
				kind: "collect-engine",
				signature:
					"collectBindleManifest(target: CollectionTarget): CollectionResult",
			},
			{
				name: "manifestFromWiring",
				kind: "collect-helper",
				signature:
					"manifestFromWiring(wiring: WiringManifest, componentHost: ComponentHostDescriptor): ManifestV1",
			},
			{
				name: "createCollectionEvents",
				kind: "collect-events",
				signature:
					"createCollectionEvents(input: { bindleId: string; manifestHash: ManifestHash; resources: readonly string[]; binds: readonly string[] }): readonly CollectionEvent[]",
			},
			{
				name: "CollectionEngineError",
				kind: "collect-error",
				signature: "class CollectionEngineError extends Error",
			},
			{
				name: "COLLECTION_EVENT_SOURCE",
				kind: "collect-constant",
				signature: 'const COLLECTION_EVENT_SOURCE: "hobo.collector"',
			},
			{
				name: "env",
				kind: "helper",
				signature:
					"env(config: Readonly<Record<string, string | number | boolean>>): ProviderAnnotation",
			},
			{
				name: "config",
				kind: "config-schema",
				signature:
					"config(fields: Readonly<Record<string, FieldBuilder | ConfigFieldDef>>): ConfigSchema",
			},
			{
				name: "fromBinding",
				kind: "config-schema",
				signature: "fromBinding(resourceName: string): ConfigFieldDef",
			},
			{
				name: "schemaOnlyView",
				kind: "config-schema",
				signature:
					"schemaOnlyView(schema: ConfigSchema): Readonly<{ schemaVersion; schemaHash; fields }>",
			},
			{
				name: "SECRET_SOURCE_RANKS",
				kind: "config-schema-constant",
				signature:
					'const SECRET_SOURCE_RANKS: readonly ["bound-resource","provider-federation","camp-value","static-escape"]',
			},
			{
				name: "sourceRankIndex",
				kind: "config-schema",
				signature: "sourceRankIndex(source: SecretSourceRank): number",
			},
			{
				name: "assertSourceAllowed",
				kind: "config-schema",
				signature:
					"assertSourceAllowed(field: ConfigFieldDef, allowedRanks: readonly SecretSourceRank[]): void",
			},
			{
				name: "envField",
				kind: "config-schema",
				signature: "envField: { string(); boolean(); int(); json() }",
			},
			{
				name: "secretField",
				kind: "config-schema",
				signature: "secretField: { string() }",
			},
			{
				name: "generateCtxConfigSource",
				kind: "config-codegen",
				signature:
					"generateCtxConfigSource(schema: ConfigSchema, options?): string",
			},
			{
				name: "evaluateSecretlessConfigGate",
				kind: "config-can-deploy",
				signature:
					"evaluateSecretlessConfigGate(input: SecretlessConfigGateInput): SecretlessConfigGateResult",
			},
			{
				name: "collectRequiredRuntimes",
				kind: "dependency-helper",
				signature:
					"collectRequiredRuntimes(definition: BindleDefinition): readonly RequiredRuntimeKind[]",
			},
			{
				name: "DEPENDENCY_OPTION",
				kind: "dependency-constant",
				signature: 'const DEPENDENCY_OPTION: "dependency"',
			},
			{
				name: "dependencyAnnotation",
				kind: "dependency-helper",
				signature: "dependencyAnnotation(config): ProviderAnnotation",
			},
			{
				name: "externalDependencyAnnotation",
				kind: "dependency-helper",
				signature:
					"externalDependencyAnnotation(options?: ExternalDependencyOptions): ProviderAnnotation",
			},
			{
				name: "containerDependencyAnnotation",
				kind: "dependency-helper",
				signature:
					"containerDependencyAnnotation(options: ContainerDependencyOptions): ProviderAnnotation",
			},
			{
				name: "wasmComponentDependencyAnnotation",
				kind: "dependency-helper",
				signature:
					"wasmComponentDependencyAnnotation(options: WasmComponentDependencyOptions): ProviderAnnotation",
			},
			{
				name: "isDependencyAnnotation",
				kind: "dependency-helper",
				signature:
					"isDependencyAnnotation(annotation: ProviderAnnotation): boolean",
			},
			{
				name: "dependencyRuntimeOf",
				kind: "dependency-helper",
				signature:
					'dependencyRuntimeOf(annotation: ProviderAnnotation): "wasm" | "oci" | "none" | undefined',
			},
			{
				name: "readDependencyConfig",
				kind: "dependency-helper",
				signature:
					"readDependencyConfig(annotations: readonly ProviderAnnotation[]): JsonObject | null",
			},
			{
				name: "discoveryEnvForDependency",
				kind: "dependency-helper",
				signature:
					"discoveryEnvForDependency(resourceName, config, resolved): Record<string, string>",
			},
			{
				name: "BINDLE_FEATURES_SCHEMA",
				kind: "features-constant",
				signature: 'const BINDLE_FEATURES_SCHEMA: "hobo.bindle-features/v1"',
			},
			{
				name: "features",
				kind: "features-builder",
				signature:
					"features(defs: Readonly<Record<string, FeatureFlagSpec>>): FeaturesDeclaration",
			},
			{
				name: "declareExperiment",
				kind: "features-builder",
				signature:
					"declareExperiment(name: string, spec: ExperimentSpec): ExperimentDeclaration",
			},
			{
				name: "rollout",
				kind: "features-builder",
				signature: "rollout(spec: RolloutSpec): RolloutDeclaration",
			},
			{
				name: "featureSpecsToStoreInputs",
				kind: "features-helper",
				signature:
					"featureSpecsToStoreInputs(decl: FeaturesDeclaration): readonly FlagStoreInput[]",
			},
			{
				name: "rolloutResource",
				kind: "resource-factory",
				signature:
					'rolloutResource(name: string): ResourceHandle<"rollout", "start" | "step" | "promote" | "rollback">',
			},
			{
				name: "sessionReplay",
				kind: "session-replay-annotation",
				signature:
					"sessionReplay(config?: SessionReplayBindleConfig): ProviderAnnotation",
			},
			{
				name: "SESSION_REPLAY_OPTION",
				kind: "session-replay-constant",
				signature: 'const SESSION_REPLAY_OPTION: "session-replay"',
			},
			{
				name: "isSessionReplayAnnotation",
				kind: "session-replay-helper",
				signature:
					"isSessionReplayAnnotation(annotation: ProviderAnnotation): boolean",
			},
			{
				name: "defaultAppKitSessionReplayAnnotation",
				kind: "session-replay-helper",
				signature: "defaultAppKitSessionReplayAnnotation(): ProviderAnnotation",
			},
			{
				name: "statusPage",
				kind: "status-page-annotation",
				signature:
					"statusPage(config?: StatusPageBindleConfig): ProviderAnnotation",
			},
			{
				name: "STATUS_PAGE_OPTION",
				kind: "status-page-constant",
				signature: 'const STATUS_PAGE_OPTION: "status-page"',
			},
			{
				name: "isStatusPageAnnotation",
				kind: "status-page-helper",
				signature:
					"isStatusPageAnnotation(annotation: ProviderAnnotation): boolean",
			},
			{
				name: "readStatusPageConfig",
				kind: "status-page-helper",
				signature:
					"readStatusPageConfig(annotations: readonly ProviderAnnotation[]): StatusPageBindleConfig | null",
			},
			{
				name: "APP_KIT_KINDS",
				kind: "app-kit-constant",
				signature:
					'const APP_KIT_KINDS: readonly ["api","web","service","ui","websocket","job","wasm-component"]',
			},
			{
				name: "HTTP_APP_KIT_KINDS",
				kind: "app-kit-constant",
				signature:
					'const HTTP_APP_KIT_KINDS: readonly ["api","web","service","ui"]',
			},
			{
				name: "INFRA_KIT_KINDS",
				kind: "app-kit-constant",
				signature: "const INFRA_KIT_KINDS: readonly ResourceKind[]",
			},
			{
				name: "isAppKitKind",
				kind: "app-kit-helper",
				signature: "isAppKitKind(kind: string): kind is AppKitKind",
			},
			{
				name: "isHttpAppKitKind",
				kind: "app-kit-helper",
				signature: "isHttpAppKitKind(kind: string): kind is HttpAppKitKind",
			},
			{
				name: "appKitLabel",
				kind: "app-kit-helper",
				signature: "appKitLabel(kind: AppKitKind): string",
			},
			{
				name: "WEBAPP_OPTION",
				kind: "webapp-constant",
				signature: 'const WEBAPP_OPTION: "webapp"',
			},
			{
				name: "WASP_WEBAPP_METADATA",
				kind: "webapp-metadata-symbol",
				signature: "const WASP_WEBAPP_METADATA: symbol",
			},
			{
				name: "webAppAnnotationFromBinding",
				kind: "webapp-helper",
				signature:
					"webAppAnnotationFromBinding(binding: ComponentBinding | undefined): ProviderAnnotation | undefined",
			},
			{
				name: "isWebAppAnnotation",
				kind: "webapp-helper",
				signature:
					"isWebAppAnnotation(annotation: ProviderAnnotation): boolean",
			},
			...extraExports,
		],
	};
}

function assertNoInternalCloudSymbols(snapshot: JsonObject): void {
	const leaks: Array<{ path: string; value: string }> = [];
	const visit = (value: JsonValue, path: string) => {
		if (isJsonString(value)) {
			if (FORBIDDEN_PUBLIC_SYMBOL.test(value)) leaks.push({ path, value });
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((entry, index) => {
				visit(entry, `${path}[${index}]`);
			});
			return;
		}
		if (value && isJsonObject(value)) {
			for (const [key, child] of Object.entries(value)) {
				visit(child, `${path}.${key}`);
			}
		}
	};
	visit(snapshot, "$");
	if (leaks.length > 0) {
		throw new Error(
			`BINDLES_API_INTERNAL_SYMBOL_LEAK: ${JSON.stringify(leaks)}`,
		);
	}
}

describe("public API snapshot", () => {
	it("matches the frozen bindles-public-api.snapshot.json contract", () => {
		const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
		const actual = createBindlesPublicApiSnapshot();

		expect(actual).toEqual(expected);
		assertNoInternalCloudSymbols(actual);
	});

	it("does not export topology, runtime, or search symbols", () => {
		const exportNames = new Set(Object.keys(bindles));
		for (const forbidden of [
			"search",
			"camp",
			"yard",
			"junction",
			"workflow",
			"step",
		]) {
			expect(exportNames.has(forbidden)).toBe(false);
		}
	});

	it("fails when an internal provider symbol leaks into exports", () => {
		const polluted = createBindlesPublicApiSnapshot({
			...bindles,
			AwsRdsInternalOptions: Object.freeze({}),
		} as typeof bindles);

		expect(() => assertNoInternalCloudSymbols(polluted)).toThrow(
			/BINDLES_API_INTERNAL_SYMBOL_LEAK/,
		);
		expect(polluted.exports).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "AwsRdsInternalOptions" }),
			]),
		);
	});
});
