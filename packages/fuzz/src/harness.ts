import {
	type FuzzValue,
	hasPrototypePollution,
	parseOrReject,
} from "./manifest.js";

export const MAX_HARNESS_BYTES = 65_536;

function decodeJson(data: Uint8Array): FuzzValue | undefined {
	if (data.byteLength > MAX_HARNESS_BYTES) return undefined;
	const text = Buffer.from(data).toString("utf8");
	try {
		return JSON.parse(text) as FuzzValue;
	} catch {
		return undefined;
	}
}

export function fuzzBindleManifest(data: Uint8Array): void {
	const parsed = decodeJson(data);
	if (parsed === undefined) return;
	if (hasPrototypePollution(parsed)) {
		const accepted = parseOrReject(parsed);
		if (accepted !== "rejected") {
			throw new Error("prototype-polluted document was accepted");
		}
		return;
	}
	parseOrReject(parsed);
}

export function fuzzEventEnvelope(data: Uint8Array): void {
	const parsed = decodeJson(data);
	if (parsed === undefined) return;
	if (hasPrototypePollution(parsed)) {
		throw new Error("event envelope injected __proto__ / constructor");
	}
}

export function fuzzPolicyDocument(data: Uint8Array): void {
	const parsed = decodeJson(data);
	if (parsed === undefined) return;
	if (hasPrototypePollution(parsed)) {
		throw new Error("policy document injected unexpected properties");
	}
	if (parsed && Object(parsed) === parsed) {
		const rec = parsed as { effect?: unknown };
		if (rec.effect === "allow" && !Object.hasOwn(rec, "resource")) {
			return;
		}
	}
}
