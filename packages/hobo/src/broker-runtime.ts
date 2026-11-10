/**
 * Embedded broker-runtime for an installed local Yard.
 *
 * Yard-first placement: Bindle is provider-agnostic; the Broker selects a
 * registered Yard (or generates one under policy), then a Camp inside that Yard,
 * then runs resolvers under the Yard provider. Bindle provider pins are rejected.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	assertNoBindleProviderSelection,
	BINDLE_PROVIDER_SELECTION_FORBIDDEN,
	BINDLE_PROVIDER_SELECTION_REMEDIATION,
	type BindleDefinition,
	collectRequiredRuntimes,
	type RequiredRuntimeKind,
} from "@hobo/bindles";
import {
	type BrokerCatalog,
	type BrokerCatalogDefinition,
	type BrokerPolicySet,
	type BrokerResolution,
	buildDeploymentRequestFromParts,
	createBroker,
	type HoboBroker,
	LOCAL_HOST_PROVIDER_ID,
	LOCAL_HOST_REGION,
	resolveBindleDeployment,
	type YardPlacementReceipt,
} from "@hobo/broker";
import type { HoboRuntimeHost } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import {
	initStation,
	listStationIds,
	resolveStationContext,
} from "@hobo/stations";
import {
	type BareMetalYardConfig,
	type ComponentHostKind,
	DEFAULT_COMPONENT_HOST,
	defaultHoboHome,
	loadBareMetalYardConfig,
	normalizeComponentHostKind,
	openBareMetalYard,
	yardConfigPath,
} from "./bare-metal-yard.js";
import { loadHoboProfile, setDefaultStation } from "./hobo-profile.js";
import { getRuntimeHost } from "./host-registry.js";
import {
	installedHostKinds,
	isRuntimeInstalled,
} from "./installed-runtimes.js";
import { isJsonString } from "./json.js";
import {
	OCI_PROVIDER_ID,
	providerIdToHost,
	RUNTIME_PROVIDER_IDS,
	WASM_SANDBOX_PROVIDER_ID as RUNTIME_WASM_SANDBOX_ID,
} from "./runtime-catalog.js";
import { ensureIsolatedWasmToolchain } from "./wasm-sandbox.js";

// public-contract: embedded broker-runtime document schema id.
export const EMBEDDED_BROKER_SCHEMA = "hobo.broker-runtime/v1" as const;
// public-contract: provider id the wasm-sandbox yard registers under.
export const WASM_SANDBOX_PROVIDER_ID = RUNTIME_WASM_SANDBOX_ID;
export const LOCAL_PROCESS_PROVIDER_ID = LOCAL_HOST_PROVIDER_ID;
export { OCI_PROVIDER_ID };

export interface EmbeddedBrokerState {
	readonly schemaVersion: typeof EMBEDDED_BROKER_SCHEMA;
	readonly brokerId: string;
	readonly preferredComponentHost: ComponentHostKind;
	readonly catalogHash: string;
	readonly updatedAt: string;
}

export interface PlacementResult {
	readonly outcome: "resolved" | "rejected";
	readonly brokerId: string;
	readonly campId: string;
	readonly yardName: string;
	readonly componentHost: ComponentHostKind;
	readonly providerId: string;
	readonly resolution: BrokerResolution;
	/** @deprecated Always empty — Bindle provider pins are forbidden. */
	readonly explicitProviders: readonly string[];
	readonly requiredRuntimes?: readonly RequiredRuntimeKind[];
	readonly yardPlacement?: YardPlacementReceipt;
	readonly message: string;
	readonly remediation?: readonly string[];
}

function brokerStatePath(hoboHome: string): string {
	return join(hoboHome, "broker-runtime.json");
}

function portForResourceKind(kind: string): string {
	if (kind === "web") return "hobo:web-app";
	if (kind === "api" || kind === "service") return "hobo:http-service";
	if (kind === "kv") return "hobo:key-value";
	if (kind === "bucket") return "hobo:object-store";
	if (kind === "queue") return "hobo:message-queue";
	if (kind === "data") return "hobo:event-store";
	if (kind === "container") return "hobo:container";
	if (kind === "wasm-component") return "hobo:wasm-component";
	if (kind === "external") return "hobo:external";
	return `hobo:${kind}`;
}

/**
 * Re-export bindles collector for broker + CLI.
 */
export { collectRequiredRuntimes } from "@hobo/bindles";

/**
 * @deprecated Bindle provider pins are forbidden. Asserts none exist and returns [].
 * Prefer assertNoBindleProviderSelection from @hobo/bindles.
 */
export function collectExplicitProviderPins(
	definition: BindleDefinition,
): readonly string[] {
	assertNoBindleProviderSelection(definition);
	return Object.freeze([]);
}

function definitionEntry(options: {
	readonly id: string;
	readonly providerId: string;
	readonly port: string;
	readonly features?: readonly string[];
	readonly marginalPrice: string;
}): BrokerCatalogDefinition {
	return {
		id: options.id,
		providerId: options.providerId,
		port: options.port,
		features: [...(options.features ?? [])],
		regions: [LOCAL_HOST_REGION],
		cost: {
			sku: options.providerId,
			unit: "hour",
			marginalPrice: options.marginalPrice,
		},
		satisfies: (req) =>
			req.port === options.port || options.port === "*"
				? { kind: "full" }
				: { kind: "none" },
	};
}

/**
 * Catalog of yards available to the embedded broker.
 * Wasm/oci hosts are cheaper when installed so min-cost prefers them.
 */
export function createYardBrokerCatalog(options: {
	readonly includeWasmSandbox: boolean;
	readonly includeOci?: boolean;
}): BrokerCatalog {
	const definitions: BrokerCatalogDefinition[] = [
		definitionEntry({
			id: `${LOCAL_PROCESS_PROVIDER_ID}:http`,
			providerId: LOCAL_PROCESS_PROVIDER_ID,
			port: "hobo:http-service",
			marginalPrice: "0.02",
		}),
		definitionEntry({
			id: `${LOCAL_PROCESS_PROVIDER_ID}:web`,
			providerId: LOCAL_PROCESS_PROVIDER_ID,
			port: "hobo:web-app",
			marginalPrice: "0.02",
		}),
		definitionEntry({
			id: `${LOCAL_PROCESS_PROVIDER_ID}:*`,
			providerId: LOCAL_PROCESS_PROVIDER_ID,
			port: "*",
			marginalPrice: "0.02",
		}),
	];
	if (options.includeWasmSandbox) {
		definitions.push(
			definitionEntry({
				id: `${WASM_SANDBOX_PROVIDER_ID}:http`,
				providerId: WASM_SANDBOX_PROVIDER_ID,
				port: "hobo:http-service",
				features: ["wasm-sandbox"],
				marginalPrice: "0.00",
			}),
			definitionEntry({
				id: `${WASM_SANDBOX_PROVIDER_ID}:web`,
				providerId: WASM_SANDBOX_PROVIDER_ID,
				port: "hobo:web-app",
				features: ["wasm-sandbox"],
				marginalPrice: "0.00",
			}),
			definitionEntry({
				id: `${WASM_SANDBOX_PROVIDER_ID}:*`,
				providerId: WASM_SANDBOX_PROVIDER_ID,
				port: "*",
				features: ["wasm-sandbox"],
				marginalPrice: "0.00",
			}),
			definitionEntry({
				id: `${RUNTIME_PROVIDER_IDS.wasm}:*`,
				providerId: RUNTIME_PROVIDER_IDS.wasm,
				port: "*",
				features: ["wasm-sandbox", "component-host"],
				marginalPrice: "0.00",
			}),
		);
	}
	if (options.includeOci) {
		definitions.push(
			definitionEntry({
				id: `${OCI_PROVIDER_ID}:http`,
				providerId: OCI_PROVIDER_ID,
				port: "hobo:http-service",
				features: ["kubernetes-oci", "container"],
				marginalPrice: "0.01",
			}),
			definitionEntry({
				id: `${OCI_PROVIDER_ID}:*`,
				providerId: OCI_PROVIDER_ID,
				port: "*",
				features: ["kubernetes-oci", "container", "component-host"],
				marginalPrice: "0.01",
			}),
			definitionEntry({
				id: `${RUNTIME_PROVIDER_IDS.oci}:*`,
				providerId: RUNTIME_PROVIDER_IDS.oci,
				port: "*",
				features: ["kubernetes-oci", "container", "component-host"],
				marginalPrice: "0.01",
			}),
		);
	}
	const catalogHash = `sha256:yard-broker:${options.includeWasmSandbox ? "w" : ""}${options.includeOci ? "o" : ""}:${options.includeWasmSandbox || options.includeOci ? "x" : "local"}`;
	return {
		catalogHash,
		definitions: () => definitions.map((d) => ({ ...d })),
	};
}

export function defaultEmbeddedPolicySet(
	brokerId: string,
	options: { readonly preferWasmSandbox: boolean } = {
		preferWasmSandbox: true,
	},
): BrokerPolicySet {
	return {
		schemaVersion: "hobo.broker/v1",
		brokerId,
		placementPolicies: [
			{
				id: "pp-embedded-default",
				scopeKind: "bindle",
				objective: "min-cost",
				// Empty allow-list = all catalog providers eligible.
				// Explicit bindle pins are enforced separately (hard fail).
				allowedProviders: [],
				deniedProviders: options.preferWasmSandbox
					? []
					: [WASM_SANDBOX_PROVIDER_ID],
				allowedRegions: [],
				requireExplicitCamps: false,
			},
		],
		billing: {
			quota: "deployments/day",
			quotaUsed: 0,
			quotaLimit: 10_000,
			budgetUsd: 0,
			spendCapUsd: 0,
		},
		delivery: { engine: "in-proc", syncMode: "auto", prune: false },
		requiredConnectorKinds: [],
	};
}

export function loadEmbeddedBrokerState(
	hoboHome: string = defaultHoboHome(),
): EmbeddedBrokerState | null {
	const path = brokerStatePath(hoboHome);
	if (!existsSync(path)) return null;
	try {
		// SAFETY: assertion required at this I/O or test boundary.
		const raw = JSON.parse(readFileSync(path, "utf8")) as EmbeddedBrokerState;
		if (raw.schemaVersion !== EMBEDDED_BROKER_SCHEMA) return null;
		return raw;
	} catch {
		return null;
	}
}

export function saveEmbeddedBrokerState(
	state: EmbeddedBrokerState,
	hoboHome: string = defaultHoboHome(),
): string {
	mkdirSync(hoboHome, { recursive: true });
	const path = brokerStatePath(hoboHome);
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, "utf8");
	return path;
}

export async function ensureEmbeddedBroker(
	options: {
		readonly hoboHome?: string;
		readonly preferWasmSandbox?: boolean;
		readonly emitProgress?: (message: string) => void;
		/** Where a runtime host comes from; defaults to the composition's registry. */
		readonly runtimeHost?: (kind: ComponentHostKind) => HoboRuntimeHost;
	} = {},
): Promise<{
	readonly state: EmbeddedBrokerState;
	readonly broker: HoboBroker;
	readonly catalog: BrokerCatalog;
	readonly wasmAvailable: boolean;
	readonly pins: Readonly<{
		stationId: string;
		railHash: string;
		bootstrapActive: boolean;
	}>;
}> {
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const emit = options.emitProgress ?? (() => {});
	const installed = installedHostKinds(hoboHome);
	const wasmInstalled = installed.includes("wasm");
	const ociInstalled = installed.includes("oci");

	let wasmAvailable = false;
	if (wasmInstalled || options.preferWasmSandbox !== false) {
		try {
			await ensureIsolatedWasmToolchain({
				hoboHome,
				download: options.preferWasmSandbox !== false,
				emitProgress: emit,
			});
			wasmAvailable = true;
		} catch {
			wasmAvailable = false;
			emit(
				"hobo broker-runtime: local process yard is the default (isolated-wasm not equipped)",
			);
		}
	}

	let ociReady = false;
	if (ociInstalled) {
		try {
			const ensure = await (options.runtimeHost ?? getRuntimeHost)(
				"oci",
			).ensure({
				hoboHome,
				emitProgress: emit,
			});
			ociReady = ensure.ready;
		} catch {
			ociReady = false;
			emit("hobo broker-runtime: oci runtime ensure failed");
		}
	}

	// Only surface wasm/oci in the junction when installed AND ready.
	const includeWasm = wasmInstalled && wasmAvailable;
	const includeOci = ociInstalled && ociReady;
	// Back-compat: if operator never ran `hobo add runtime-*` beyond bootstrap
	// but wasm tools equip, still offer wasm (legacy yards).
	const legacyWasm =
		!wasmInstalled &&
		wasmAvailable &&
		options.preferWasmSandbox !== false &&
		installed.length === 1 &&
		installed[0] === "local";

	const preferWasm = includeWasm || legacyWasm;
	const existing = loadEmbeddedBrokerState(hoboHome);
	const brokerId = existing?.brokerId ?? `broker:local/${hostname()}`;
	const catalog = createYardBrokerCatalog({
		includeWasmSandbox: preferWasm,
		includeOci,
	});
	const policies = defaultEmbeddedPolicySet(brokerId, {
		preferWasmSandbox: preferWasm,
	});
	// Embedded Conductor requires Station occupancy (same as CLI broker path).
	// Zero-config local: auto-bootstrap station:local when none exists under HOBO_HOME.
	const profile = loadHoboProfile(hoboHome);
	const existingStations = listStationIds(hoboHome);
	if (
		existingStations.length === 0 &&
		profile?.defaultStation?.id === undefined &&
		!isJsonString(process.env.HOBO_STATION)
	) {
		const boot = initStation({
			hoboHome,
			id: "station:local",
			name: "local",
			tenant: "local",
		});
		setDefaultStation(
			hoboHome,
			{ id: boot.stationId, dataDir: boot.dataDir },
			boot.occupancy.activeRailHash,
		);
		emit(`hobo broker-runtime: bootstrapped ${boot.stationId} for local Yard`);
	}
	const stationCtx = resolveStationContext({
		hoboHome,
		...(isJsonString(process.env.HOBO_STATION)
			? { stationEnv: process.env.HOBO_STATION }
			: undefined),
		...(loadHoboProfile(hoboHome)?.defaultStation?.id !== undefined
			? {
					profileStationId: must(
						must(loadHoboProfile(hoboHome), "loadHoboProfile(hoboHome)")
							.defaultStation,
						"loadHoboProfile(hoboHome)!.defaultStation",
					).id,
				}
			: existingStations[0] !== undefined
				? { profileStationId: existingStations[0] }
				: { profileStationId: "station:local" }),
	});
	const pins = stationCtx.client.pins();
	const broker = createBroker({
		policies,
		catalog,
		stationId: pins.stationId,
		railHash: pins.railHash,
	});
	const preferred: ComponentHostKind = includeOci
		? "oci"
		: preferWasm
			? "wasm"
			: "local";
	const state: EmbeddedBrokerState = {
		schemaVersion: EMBEDDED_BROKER_SCHEMA,
		brokerId,
		preferredComponentHost: preferred,
		catalogHash: catalog.catalogHash,
		updatedAt: new Date().toISOString(),
	};
	saveEmbeddedBrokerState(state, hoboHome);
	emit(
		`hobo broker-runtime: ready ${brokerId} (prefer ${state.preferredComponentHost})`,
	);
	return { state, broker, catalog, wasmAvailable: preferWasm, pins };
}

function componentHostForProvider(
	providerId: string,
	fallback: ComponentHostKind,
): ComponentHostKind {
	return providerIdToHost(providerId) ?? fallback;
}

/**
 * Resolve deployment placement through the embedded broker (Yard-first).
 * Bindle is provider-agnostic; Yard selection owns provider context.
 * Creates a Camp id inside the selected Yard when none is named.
 * Rejects Bindle provider selection annotations.
 */
export async function resolveBindlePlacement(options: {
	readonly definition: BindleDefinition;
	readonly hoboHome?: string;
	readonly yard?: BareMetalYardConfig | null;
	readonly campId?: string;
	readonly yardId?: string;
	readonly providerId?: string;
	readonly selectionMode?: "exact" | "compatible" | "compatible-or-generate";
	readonly emitProgress?: (message: string) => void;
	/** Where a runtime host comes from; defaults to the composition's registry. */
	readonly runtimeHost?: (kind: ComponentHostKind) => HoboRuntimeHost;
}): Promise<PlacementResult> {
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const emit = options.emitProgress ?? (() => {});
	const yardConfig = options.yard ?? loadBareMetalYardConfig(hoboHome) ?? null;

	// Fail fast: Bindle must not select providers.
	try {
		assertNoBindleProviderSelection(options.definition);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			outcome: "rejected",
			brokerId: "uninitialized",
			campId: options.campId ?? "unplaced",
			yardName: yardConfig?.name ?? "local",
			componentHost: yardConfig?.componentHost ?? DEFAULT_COMPONENT_HOST,
			providerId: "none",
			resolution: {
				outcome: "rejected",
				rejection: {
					schemaVersion: "hobo.broker/v1",
					requestId: "bindle-provider-check",
					brokerId: "uninitialized",
					// SAFETY: assertion required at this I/O or test boundary.
					policyHash: "sha256:none" as never,
					// Pre-station fail-fast: no Station occupancy exists yet.
					stationId: "uninitialized",
					railHash: "sha256:none",
					reasons: [
						{
							plane: "placement",
							code: BINDLE_PROVIDER_SELECTION_FORBIDDEN,
							message,
						},
					],
				},
				events: [],
			},
			explicitProviders: [],
			message,
			remediation: [
				BINDLE_PROVIDER_SELECTION_REMEDIATION,
				"Remove .with({ provider }) / provider-specific Bindle annotations.",
				"Declare or request a provider-specific Yard and attach this Bindle deployment to it.",
			],
		};
	}

	// Fail fast on missing runtimes before equipping toolchains / downloading wasmtime.
	const requiredRuntimes = collectRequiredRuntimes(options.definition);
	const missingRuntimes = requiredRuntimes.filter(
		(runtime) => !isRuntimeInstalled(runtime, hoboHome),
	);
	if (missingRuntimes.length > 0) {
		const message = `bindle requires runtime(s) [${missingRuntimes.join(", ")}] that are not installed on this yard/broker`;
		return {
			outcome: "rejected",
			brokerId: "uninitialized",
			campId: options.campId ?? "unplaced",
			yardName: yardConfig?.name ?? "local",
			componentHost: yardConfig?.componentHost ?? DEFAULT_COMPONENT_HOST,
			providerId: "none",
			resolution: {
				outcome: "rejected",
				rejection: {
					schemaVersion: "hobo.broker/v1",
					requestId: "runtime-check",
					brokerId: "uninitialized",
					// SAFETY: assertion required at this I/O or test boundary.
					policyHash: "sha256:none" as never,
					// Pre-station fail-fast: no Station occupancy exists yet.
					stationId: "uninitialized",
					railHash: "sha256:none",
					reasons: missingRuntimes.map((runtime) => ({
						plane: "placement" as const,
						code: "required-runtime-unavailable",
						message: `runtime ${runtime} is not installed (hobo add runtime-${runtime})`,
					})),
				},
				events: [],
			},
			explicitProviders: [],
			requiredRuntimes,
			message,
			remediation: [
				...missingRuntimes.map((r) => `Install: hobo add runtime-${r}`),
				"Then equip toolchains: hobo yard ensure",
				`Installed runtimes: ${installedHostKinds(hoboHome).join(", ") || "(none)"}`,
			],
		};
	}

	const { state, broker, catalog, pins } = await ensureEmbeddedBroker({
		hoboHome,
		emitProgress: emit,
		runtimeHost: options.runtimeHost ?? getRuntimeHost,
	});

	const yardName = yardConfig?.name ?? "local";
	const yardId = options.yardId ?? `yard:${yardName}`;
	// Prefer runtime provider from installed hosts when no explicit yard provider.
	const preferredProvider =
		options.providerId ??
		(requiredRuntimes.includes("oci")
			? OCI_PROVIDER_ID
			: isRuntimeInstalled("wasm", hoboHome)
				? WASM_SANDBOX_PROVIDER_ID
				: LOCAL_PROCESS_PROVIDER_ID);

	const resources = Object.values(options.definition.resources).map(
		(resource) => ({
			resourceId: resource.name,
			port: portForResourceKind(resource.kind),
			// SAFETY: assertion required at this I/O or test boundary.
			features: [] as string[],
		}),
	);

	const requirements = options.definition.requirements ?? {
		require: [],
		prefer: [],
		runtimes: requiredRuntimes,
		labels: {},
	};

	const deploymentRequest = buildDeploymentRequestFromParts({
		bindleName: options.definition.name,
		manifestHash: `sha256:${createHash("sha256")
			.update(
				JSON.stringify({
					name: options.definition.name,
					resources: Object.keys(options.definition.resources).sort(),
				}),
			)
			.digest("hex")}`,
		requirements: {
			require: [...requirements.require],
			prefer: [...requirements.prefer],
			runtimes: [...new Set([...requirements.runtimes, ...requiredRuntimes])],
			labels: { ...requirements.labels },
		},
		yardId,
		providerId: preferredProvider,
		selectionMode: options.selectionMode ?? "compatible",
		allowGeneration: false,
		resources,
		ownerTenantId: "local",
		objective: "min-cost",
	});

	emit(
		`hobo broker-runtime: yard-first placement for bindle:${options.definition.name} → ${yardId}`,
	);

	const yardFirst = await resolveBindleDeployment(deploymentRequest, {
		brokerId: state.brokerId,
		catalog,
		ownerTenantId: "local",
		seedLocalYard: true,
	});

	if (yardFirst.outcome === "rejected" || !yardFirst.receipt) {
		const reasons =
			yardFirst.reasons?.map((r) => r.message).join("; ") ??
			"yard-first placement rejected";
		return {
			outcome: "rejected",
			brokerId: state.brokerId,
			campId: options.campId ?? "unplaced",
			yardName,
			componentHost: state.preferredComponentHost,
			providerId: "none",
			resolution: {
				outcome: "rejected",
				rejection: {
					schemaVersion: "hobo.broker/v1",
					requestId: deploymentRequest.requestId,
					brokerId: state.brokerId,
					policyHash: broker.policyHash,
					stationId: pins.stationId,
					railHash: pins.railHash,
					reasons: (yardFirst.reasons ?? []).map((r) => ({
						// SAFETY: assertion required at this I/O or test boundary.
						plane: r.plane as "placement",
						code: r.code,
						message: r.message,
					})),
				},
				events: [],
			},
			explicitProviders: [],
			requiredRuntimes,
			message: `broker rejected placement: ${reasons}`,
			remediation: [
				"Request a compatible Yard shape or register a ready Yard instance.",
				"Run `hobo yard ensure` so local component hosts are available.",
				"Provider selection belongs on a Yard, not the Bindle.",
			],
		};
	}

	const receipt = yardFirst.receipt;
	const campId = options.campId ?? receipt.selectedCampId;
	const providerId = receipt.selectedProviderId;
	let componentHost = componentHostForProvider(
		providerId,
		state.preferredComponentHost,
	);
	if (requiredRuntimes.includes("oci")) componentHost = "oci";
	else if (requiredRuntimes.includes("wasm")) componentHost = "wasm";

	openBareMetalYard({ hoboHome });

	const resolution: BrokerResolution = {
		outcome: "resolved",
		receipt: {
			schemaVersion: "hobo.broker/v1",
			requestId: deploymentRequest.requestId,
			brokerId: state.brokerId,
			catalogHash: catalog.catalogHash,
			policyHash: broker.policyHash,
			placementPolicyId: "yard-first",
			stationId: pins.stationId,
			railHash: pins.railHash,
			placements: [...yardFirst.placements],
		},
		events: [],
	};

	return {
		outcome: "resolved",
		brokerId: state.brokerId,
		campId,
		yardName: receipt.selectedYardId.replace(/^yard:/, ""),
		componentHost,
		providerId,
		resolution,
		explicitProviders: [],
		requiredRuntimes,
		yardPlacement: receipt,
		message: `broker placed ${options.definition.name} on yard ${receipt.selectedYardId} provider ${providerId} (componentHost=${componentHost}, camp=${campId})`,
	};
}

export function describeBrokerRuntime(hoboHome: string = defaultHoboHome()) {
	return {
		yardConfigPath: yardConfigPath(hoboHome),
		brokerStatePath: brokerStatePath(hoboHome),
		yard: loadBareMetalYardConfig(hoboHome),
		broker: loadEmbeddedBrokerState(hoboHome),
	};
}

export function defaultComponentHostFromBroker(
	hoboHome: string = defaultHoboHome(),
): ComponentHostKind {
	const raw =
		loadEmbeddedBrokerState(hoboHome)?.preferredComponentHost ??
		DEFAULT_COMPONENT_HOST;
	// Normalize legacy preferredComponentHost values (isolated-wasm → wasm).
	try {
		return normalizeComponentHostKind(raw);
	} catch {
		return DEFAULT_COMPONENT_HOST;
	}
}
