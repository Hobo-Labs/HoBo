// Parse, don't validate: configuration records (kube_fleet.proto, constrained
// by kube_fleet.cue) become branded, frozen configs here and nowhere else.
// Every factory takes a parsed config, so no downstream code re-checks a URL,
// a cluster name or a DepartureAction.
import { fromJson, isMessage } from "@bufbuild/protobuf";
import { DepartureAction } from "@hobo/cd";
import type { JsonValue } from "@hobo/core";
import {
	type ClusterProfileImportRecord,
	ClusterProfileImportRecordSchema,
	HubKind,
	type KarmadaRealizerRecord,
	KarmadaRealizerRecordSchema,
	KubeAuth,
	type KubeHubRecord,
	type OcmRealizerRecord,
	OcmRealizerRecordSchema,
} from "./_generated/kube_fleet_pb.js";
import { KubeFleetError } from "./errors.js";

// public-contract: configuration schema versions.
export const KUBE_FLEET_SCHEMAS = Object.freeze({
	hub: "hobo.cd-kube-fleet.hub/v1",
	ocm: "hobo.cd-kube-fleet.ocm/v1",
	karmada: "hobo.cd-kube-fleet.karmada/v1",
	clusterProfiles: "hobo.cd-kube-fleet.cluster-profiles/v1",
} as const);

// public-contract: per-call and watch defaults.
export const KUBE_FLEET_DEFAULTS = Object.freeze({
	callTimeoutMs: 15_000,
	maxResponseBytes: 8_388_608,
	watchTimeoutSeconds: 50,
	defaultNamespace: "default",
} as const);

const API_BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/u;
const HUB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export const DNS1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;
export const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/u;
const CAMP_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;
const CAMP_PREFIX = /^[a-z0-9-]{0,32}$/u;
const LABEL_KEY =
	/^([a-z0-9.-]{1,253}\/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u;
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/u;

declare const hubBrand: unique symbol;
declare const realizerBrand: unique symbol;
declare const importBrand: unique symbol;

/** A parsed hub: https origin, credential reference, auth kind. */
export type KubeHub = Readonly<{
	name: string;
	kind: HubKind;
	apiBaseUrl: string;
	credentialRef: string;
	auth: KubeAuth.BEARER | KubeAuth.EXEC;
	timeoutMs: number;
	readonly [hubBrand]: "KubeHub";
}>;

/** A parsed realizer configuration (OCM or Karmada). */
export type RealizerConfig = Readonly<{
	hub: KubeHub;
	/** campId → cluster (OCM ManagedCluster / Karmada member). */
	clusters: ReadonlyMap<string, string>;
	departureAction: DepartureAction;
	readonly [realizerBrand]: "RealizerConfig";
}>;

/** A parsed ClusterProfile import. */
export type ClusterProfileImport = Readonly<{
	hub: KubeHub;
	namespace: string | undefined;
	yardId: string;
	stationId: string;
	provider: string;
	envType: string;
	regions: readonly string[];
	campIdPrefix: string;
	labelSelector: Readonly<Record<string, string>>;
	watchTimeoutSeconds: number;
	readonly [importBrand]: "ClusterProfileImport";
}>;

function invalid(message: string): KubeFleetError {
	return new KubeFleetError("kube-fleet-config-invalid", message);
}

/** Parse one hub record; `expect` pins the hub kind a realizer needs. */
export function parseKubeHub(record: KubeHubRecord, expect?: HubKind): KubeHub {
	if (record.schemaVersion !== KUBE_FLEET_SCHEMAS.hub)
		throw invalid(`hub.schema_version must be ${KUBE_FLEET_SCHEMAS.hub}`);
	if (!HUB_NAME.test(record.name))
		throw invalid(`hub.name ${JSON.stringify(record.name)} is not a slug`);
	if (record.kind === HubKind.UNSPECIFIED)
		throw invalid("hub.kind is required");
	if (expect !== undefined && record.kind !== expect)
		throw invalid(`hub.kind must be ${HubKind[expect]}`);
	if (!API_BASE_URL.test(record.apiBaseUrl))
		throw invalid(
			"hub.api_base_url must be https://host[:port] with no path, query or credentials",
		);
	if (record.credentialRef.trim() === "")
		throw invalid("hub.credential_ref is required");
	const timeoutMs =
		record.timeoutMs === 0
			? KUBE_FLEET_DEFAULTS.callTimeoutMs
			: record.timeoutMs;
	if (timeoutMs < 1000 || timeoutMs > 120_000)
		throw invalid("hub.timeout_ms must be within 1000..120000");
	const auth = record.auth === KubeAuth.EXEC ? KubeAuth.EXEC : KubeAuth.BEARER;
	// SAFETY: brand applied once, after every rule above held.
	return Object.freeze({
		name: record.name,
		kind: record.kind,
		apiBaseUrl: record.apiBaseUrl,
		credentialRef: record.credentialRef,
		auth,
		timeoutMs,
	}) as KubeHub;
}

function parseDeparture(name: string): DepartureAction {
	if (name === "") return DepartureAction.ORPHAN_DATA;
	const short = name.replace(/^DEPARTURE_ACTION_/u, "");
	if (short === "DELETE") return DepartureAction.DELETE;
	if (short === "ORPHAN") return DepartureAction.ORPHAN;
	if (short === "ORPHAN_DATA") return DepartureAction.ORPHAN_DATA;
	throw invalid(
		`departure_action ${JSON.stringify(name)} is not a DepartureAction`,
	);
}

function parseClusters(
	records: OcmRealizerRecord["clusters"],
): ReadonlyMap<string, string> {
	if (records.length === 0)
		throw invalid("clusters must map at least one Camp to a cluster");
	const out = new Map<string, string>();
	for (const entry of records) {
		if (!CAMP_ID.test(entry.campId))
			throw invalid(
				`clusters: camp_id ${JSON.stringify(entry.campId)} is invalid`,
			);
		if (!DNS1123_LABEL.test(entry.cluster))
			throw invalid(
				`clusters: cluster ${JSON.stringify(entry.cluster)} is not DNS-1123`,
			);
		if (out.has(entry.campId))
			throw invalid(`clusters: camp_id ${entry.campId} is mapped twice`);
		out.set(entry.campId, entry.cluster);
	}
	return out;
}

function realizerConfig(
	schema: string,
	expected: string,
	hub: KubeHubRecord | undefined,
	kind: HubKind,
	clusters: OcmRealizerRecord["clusters"],
	departure: string,
): RealizerConfig {
	if (schema !== expected) throw invalid(`schema_version must be ${expected}`);
	if (hub === undefined) throw invalid("hub is required");
	// SAFETY: brand applied once, after every rule above held.
	return Object.freeze({
		hub: parseKubeHub(hub, kind),
		clusters: parseClusters(clusters),
		departureAction: parseDeparture(departure),
	}) as RealizerConfig;
}

/** Parse an OCM realizer record (generated message or protobuf JSON). */
export function parseOcmRealizerConfig(
	input: OcmRealizerRecord | JsonValue,
): RealizerConfig {
	const record = isMessage(input, OcmRealizerRecordSchema)
		? input
		: fromJsonOrInvalid(() => fromJson(OcmRealizerRecordSchema, input));
	return realizerConfig(
		record.schemaVersion,
		KUBE_FLEET_SCHEMAS.ocm,
		record.hub,
		HubKind.OCM,
		record.clusters,
		record.departureAction,
	);
}

/** Parse a Karmada realizer record (generated message or protobuf JSON). */
export function parseKarmadaRealizerConfig(
	input: KarmadaRealizerRecord | JsonValue,
): RealizerConfig {
	const record = isMessage(input, KarmadaRealizerRecordSchema)
		? input
		: fromJsonOrInvalid(() => fromJson(KarmadaRealizerRecordSchema, input));
	return realizerConfig(
		record.schemaVersion,
		KUBE_FLEET_SCHEMAS.karmada,
		record.hub,
		HubKind.KARMADA,
		record.clusters,
		record.departureAction,
	);
}

/** Parse a ClusterProfile import record (generated message or protobuf JSON). */
export function parseClusterProfileImport(
	input: ClusterProfileImportRecord | JsonValue,
): ClusterProfileImport {
	const record = isMessage(input, ClusterProfileImportRecordSchema)
		? input
		: fromJsonOrInvalid(() =>
				fromJson(ClusterProfileImportRecordSchema, input),
			);
	if (record.schemaVersion !== KUBE_FLEET_SCHEMAS.clusterProfiles)
		throw invalid(
			`schema_version must be ${KUBE_FLEET_SCHEMAS.clusterProfiles}`,
		);
	if (record.hub === undefined) throw invalid("hub is required");
	const hub = parseKubeHub(record.hub);
	if (record.namespace !== "" && !DNS1123_LABEL.test(record.namespace))
		throw invalid(
			`namespace ${JSON.stringify(record.namespace)} is not DNS-1123`,
		);
	for (const [field, value] of [
		["yard_id", record.yardId],
		["station_id", record.stationId],
		["provider", record.provider],
		["env_type", record.envType],
	] as const) {
		if (value.trim() === "") throw invalid(`${field} is required`);
	}
	const regions = [...new Set(record.regions.map((r) => r.trim()))].filter(
		(r) => r !== "",
	);
	if (regions.length === 0)
		throw invalid(
			"regions must declare at least one region (claims never grant one)",
		);
	if (!CAMP_PREFIX.test(record.campIdPrefix))
		throw invalid("camp_id_prefix must be at most 32 of [a-z0-9-]");
	for (const [key, value] of Object.entries(record.labelSelector)) {
		if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value))
			throw invalid(`label_selector ${key}=${value} is not a valid label`);
	}
	const watchTimeoutSeconds =
		record.watchTimeoutSeconds === 0
			? KUBE_FLEET_DEFAULTS.watchTimeoutSeconds
			: record.watchTimeoutSeconds;
	if (watchTimeoutSeconds > 300)
		throw invalid("watch_timeout_seconds must be within 1..300");
	// SAFETY: brand applied once, after every rule above held.
	return Object.freeze({
		hub,
		namespace: record.namespace === "" ? undefined : record.namespace,
		yardId: record.yardId,
		stationId: record.stationId,
		provider: record.provider,
		envType: record.envType,
		regions: Object.freeze(regions.sort()),
		campIdPrefix: record.campIdPrefix,
		labelSelector: Object.freeze({ ...record.labelSelector }),
		watchTimeoutSeconds,
	}) as ClusterProfileImport;
}

function fromJsonOrInvalid<T>(parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		throw invalid(error instanceof Error ? error.message : String(error));
	}
}
