import { cloneAsJson, isJsonObject, isJsonString } from "./json.js";
import {
	RivetJournalError,
	type RivetRuntimeConfig,
	type RivetRuntimeMode,
} from "./types.js";

export function parseRivetRuntimeMode<T>(value: T): RivetRuntimeMode {
	const json = cloneAsJson(value);
	if (
		json === "local" ||
		json === "runner" ||
		json === "serverless" ||
		json === "managed"
	) {
		return json;
	}
	throw new RivetJournalError(
		"PARSE",
		`rivet runtime mode must be local|runner|serverless|managed, got ${JSON.stringify(json)}`,
	);
}

export function parseRivetActorFidelity<T>(value: T): "local-sqlite" {
	if (value === undefined || value === "local-sqlite") return "local-sqlite";
	throw new RivetJournalError(
		"PARSE",
		value === "rivetkit"
			? "RivetKit fidelity is not implemented by the local journal"
			: `rivet fidelity must be local-sqlite, got ${JSON.stringify(cloneAsJson(value))}`,
	);
}

export function parseRivetRuntimeConfig<T>(input: T): RivetRuntimeConfig {
	const json = cloneAsJson(input);
	if (!isJsonObject(json)) {
		throw new RivetJournalError(
			"PARSE",
			"rivet runtime config must be an object",
		);
	}
	const record = json;
	const campId = record.campId ?? record.camp_id;
	const tenantId = record.tenantId ?? record.tenant_id;
	if (!isJsonString(campId) || campId.length === 0) {
		throw new RivetJournalError("PARSE", "campId is required");
	}
	if (!isJsonString(tenantId) || tenantId.length === 0) {
		throw new RivetJournalError("PARSE", "tenantId is required");
	}
	const svid = record.svidBindingRef ?? record.svid_binding_ref;
	if (!isJsonString(svid) || svid.length === 0) {
		throw new RivetJournalError("PARSE", "svidBindingRef is required");
	}
	if (svid.startsWith("secret:") || /token|password|sk-/iu.test(svid)) {
		throw new RivetJournalError(
			"PARSE",
			"svidBindingRef must be a locator, not secret material",
		);
	}
	const endpoint = record.endpointSecretRef ?? record.endpoint_secret_ref;
	const admin = record.adminTokenSecretRef ?? record.admin_token_secret_ref;
	for (const [path, value] of [
		["endpointSecretRef", endpoint],
		["adminTokenSecretRef", admin],
	] as const) {
		if (value !== undefined && isJsonString(value) && value.includes("://")) {
			throw new RivetJournalError(
				"PARSE",
				`${path} must be a secretRef locator, not a URL with userinfo`,
			);
		}
	}
	return Object.freeze({
		campId,
		tenantId,
		mode: parseRivetRuntimeMode(record.mode ?? "local"),
		...(isJsonString(record.engineImageDigest)
			? { engineImageDigest: record.engineImageDigest }
			: undefined),
		...(isJsonString(endpoint) ? { endpointSecretRef: endpoint } : undefined),
		...(isJsonString(admin) ? { adminTokenSecretRef: admin } : undefined),
		svidBindingRef: svid,
	});
}
