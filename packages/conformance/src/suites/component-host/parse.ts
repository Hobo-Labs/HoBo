import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../../json.js";

export function parseComponentHostManifest(raw: JsonValue) {
	if (!raw || !isJsonObject(raw) || Array.isArray(raw)) {
		throw new TypeError("manifest must be an object");
	}

	const source = raw as JsonObject;
	const componentHost = source.componentHost;
	if (
		!componentHost ||
		!isJsonObject(componentHost) ||
		Array.isArray(componentHost)
	) {
		throw new TypeError("componentHost is required");
	}

	const hostSection = componentHost as JsonObject;
	const certifiedHosts = hostSection.certifiedHosts;
	if (!Array.isArray(certifiedHosts) || certifiedHosts.length === 0) {
		throw new TypeError("certifiedHosts must be a non-empty array");
	}

	for (const pin of certifiedHosts) {
		if (!pin || !isJsonObject(pin)) {
			throw new TypeError("certified host pin must be an object");
		}
		const entry = pin as JsonObject;
		if (!isJsonString(entry.kind) || entry.kind.length === 0) {
			throw new TypeError("host.kind must be non-empty");
		}
		if (!isJsonString(entry.version) || entry.version.length === 0) {
			throw new TypeError("host.version must be non-empty");
		}
	}

	return Object.freeze(structuredClone(raw));
}
