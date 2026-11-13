// The agent state file of design §6.4 and §7.3 (`AgentState`): generation,
// pending refresh nonce, pinned trust record, last processed stream sequences,
// seen order ids and the signed receipts not yet published (F4). Records are
// stored as their protobuf binary, base64; nothing private is ever in it.

import { fromBinary, toBinary } from "@bufbuild/protobuf";
import type { JsonObject, JsonValue } from "@hobo/core";
import {
	type AgentState,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import { isJsonNumber, isJsonObject, isJsonString } from "./json.js";

const VERSION = 1;

export function emptyAgentState(): AgentState {
	return Object.freeze({
		generation: 0,
		pendingRefreshNonce: undefined,
		trust: undefined,
		lastSequence: Object.freeze({}),
		seenOrderIds: Object.freeze([]),
		pendingReceipts: Object.freeze([]),
	});
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function encodeAgentState(state: AgentState): string {
	const lastSequence: JsonObject = Object.fromEntries(
		Object.entries(state.lastSequence),
	);
	const document: JsonObject = {
		version: VERSION,
		generation: state.generation,
		pendingRefreshNonce:
			state.pendingRefreshNonce === undefined
				? null
				: base64(state.pendingRefreshNonce),
		trust:
			state.trust === undefined
				? null
				: base64(toBinary(WitnessedEnvelopeSchema, state.trust)),
		lastSequence,
		seenOrderIds: [...state.seenOrderIds],
		pendingReceipts: state.pendingReceipts.map((receipt) =>
			base64(toBinary(SignedEnvelopeSchema, receipt)),
		),
	};
	return `${JSON.stringify(document)}\n`;
}

function refuse(reason: string): never {
	throw new Error(`the agent state file is not valid: ${reason}`);
}

function count(value: JsonValue | undefined, field: string): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0)
		refuse(`${field} is not a non-negative integer`);
	return value;
}

function bytes(value: JsonValue | undefined, field: string): Uint8Array {
	if (!isJsonString(value)) refuse(`${field} is not base64`);
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) refuse(`${field} is not base64`);
	return new Uint8Array(decoded);
}

function strings(value: JsonValue | undefined, field: string): string[] {
	if (!Array.isArray(value)) refuse(`${field} is not a list`);
	return value.map((entry) => {
		if (!isJsonString(entry)) refuse(`${field} holds a non-string`);
		return entry;
	});
}

function decodeRecord<T>(decode: () => T, field: string): T {
	try {
		return decode();
	} catch {
		return refuse(`${field} does not decode`);
	}
}

/** Parses the state file's text; throws, naming the field, when it is not one. */
export function decodeAgentState(text: string): AgentState {
	let document: JsonValue;
	try {
		document = JSON.parse(text);
	} catch {
		return refuse("it is not JSON");
	}
	if (!isJsonObject(document)) return refuse("it is not an object");
	if (document.version !== VERSION)
		refuse(`version ${String(document.version)} is not ${VERSION}`);
	const sequences = document.lastSequence;
	if (!isJsonObject(sequences)) return refuse("lastSequence is not an object");
	const lastSequence: Record<string, number> = {};
	for (const [stream, sequence] of Object.entries(sequences))
		lastSequence[stream] = count(sequence, `lastSequence.${stream}`);
	const nonce = document.pendingRefreshNonce;
	const trust = document.trust;
	const pendingReceipts: SignedEnvelope[] = strings(
		document.pendingReceipts,
		"pendingReceipts",
	).map((entry, index) =>
		decodeRecord(
			() =>
				fromBinary(
					SignedEnvelopeSchema,
					bytes(entry, `pendingReceipts[${index}]`),
				),
			`pendingReceipts[${index}]`,
		),
	);
	return Object.freeze({
		generation: count(document.generation, "generation"),
		pendingRefreshNonce:
			nonce === null ? undefined : bytes(nonce, "pendingRefreshNonce"),
		trust:
			trust === null
				? undefined
				: decodeRecord(
						() => fromBinary(WitnessedEnvelopeSchema, bytes(trust, "trust")),
						"trust",
					),
		lastSequence: Object.freeze(lastSequence),
		seenOrderIds: Object.freeze(strings(document.seenOrderIds, "seenOrderIds")),
		pendingReceipts: Object.freeze(pendingReceipts),
	});
}
