import { isDeepStrictEqual } from "node:util";
import { EnvelopeParseError, parseEventEnvelope } from "@hobo/core";
import {
	PolicyIrValidationError,
	parsePolicyIrDocument,
	serializePolicyIrDocument,
} from "@hobo/policy";
import {
	type FuzzValue,
	hasPrototypePollution,
	parseOrReject,
} from "./manifest.js";

export const MAX_HARNESS_BYTES = 65_536;
export type HarnessOutcome =
	| "accepted"
	| "rejected"
	| "invalid-json"
	| "oversized";

function decodeJson(data: Uint8Array): FuzzValue | undefined {
	if (data.byteLength > MAX_HARNESS_BYTES) return undefined;
	try {
		const parsed: FuzzValue = JSON.parse(Buffer.from(data).toString("utf8"));
		return parsed;
	} catch {
		return undefined;
	}
}

export function fuzzBindleManifest(data: Uint8Array): void {
	const parsed = decodeJson(data);
	if (parsed === undefined) return;
	if (hasPrototypePollution(parsed)) {
		const accepted = parseOrReject(parsed);
		if (accepted !== "rejected")
			throw new Error("prototype-polluted document was accepted");
		return;
	}
	parseOrReject(parsed);
}

export function fuzzEventEnvelope(data: Uint8Array): HarnessOutcome {
	if (data.byteLength > MAX_HARNESS_BYTES) return "oversized";
	const parsed = decodeJson(data);
	if (parsed === undefined) return "invalid-json";
	let event: ReturnType<typeof parseEventEnvelope>;
	try {
		event = parseEventEnvelope(parsed);
	} catch (error) {
		if (error instanceof EnvelopeParseError) return "rejected";
		throw error;
	}
	const replay = parseEventEnvelope(JSON.parse(JSON.stringify(event)));
	if (!isDeepStrictEqual(event, replay))
		throw new Error("event envelope changed during replay");
	return "accepted";
}

export function fuzzPolicyDocument(data: Uint8Array): HarnessOutcome {
	if (data.byteLength > MAX_HARNESS_BYTES) return "oversized";
	const parsed = decodeJson(data);
	if (parsed === undefined) return "invalid-json";
	if (parsed === null || Object(parsed) !== parsed || Array.isArray(parsed))
		return "rejected";
	let document: ReturnType<typeof parsePolicyIrDocument>;
	try {
		document = parsePolicyIrDocument(parsed);
	} catch (error) {
		if (error instanceof PolicyIrValidationError) return "rejected";
		throw error;
	}
	const replay = parsePolicyIrDocument(serializePolicyIrDocument(document));
	if (!isDeepStrictEqual(document, replay))
		throw new Error("policy document changed during replay");
	return "accepted";
}
