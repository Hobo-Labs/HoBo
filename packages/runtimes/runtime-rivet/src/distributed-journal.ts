import type { FoldEvent } from "@hobo/core";
import { isJsonObject, isJsonString } from "./json.js";

const LEASE_MS = 30_000;
const MAX_GRANTS = 4_096;
const MAX_EVENTS = 1_024;
const MAX_EVENT_BYTES = 32_768;
const MAX_JOURNAL_BYTES = 4_194_304;

interface Grant {
	readonly requestId: string;
	readonly holderId: string;
	readonly fenceToken: number;
	readonly expiresAtMs: number;
}
interface Entry {
	readonly eventId: string;
	readonly eventJson: string;
	readonly expectedRevision: number;
}
export interface DistributedJournalState {
	readonly version: 1;
	readonly epoch: number;
	readonly lastNowMs: number;
	readonly current: Grant | null;
	readonly grants: readonly Grant[];
	readonly entries: readonly Entry[];
	readonly bytes: number;
}
export type DistributedJournalCommand =
	| {
			readonly kind: "acquire";
			readonly requestId: string;
			readonly holderId: string;
			readonly nowMs: number;
	  }
	| {
			readonly kind: "release" | "check";
			readonly holderId: string;
			readonly requestId: string;
			readonly fenceToken: number;
			readonly nowMs: number;
	  }
	| {
			readonly kind: "append";
			readonly holderId: string;
			readonly requestId: string;
			readonly fenceToken: number;
			readonly expectedRevision: number;
			readonly eventId: string;
			readonly event: FoldEvent;
			readonly nowMs: number;
	  };
export type DistributedJournalResult =
	| { readonly status: "denied"; readonly code: string }
	| {
			readonly status: "acquired";
			readonly fenceToken: number;
			readonly expiresAtMs: number;
			readonly duplicate: boolean;
	  }
	| { readonly status: "released" }
	| { readonly status: "valid" }
	| {
			readonly status: "appended";
			readonly revision: number;
			readonly duplicate: boolean;
	  };
export interface DistributedJournalTransition {
	readonly state: DistributedJournalState;
	readonly result: DistributedJournalResult;
}

export function initialDistributedJournal(): DistributedJournalState {
	return {
		version: 1,
		epoch: 0,
		lastNowMs: 0,
		current: null,
		grants: [],
		entries: [],
		bytes: 0,
	};
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: identities arrive through Rivet action inputs and persisted state. */
function name(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: actor action inputs cross a network boundary and must be bounded plain JSON data. */
function plainJson(
	value: unknown,
	depth: number,
	seen: Set<object>,
	remaining: { n: number; bytes: number },
): unknown {
	if (--remaining.n < 0 || depth > 32) throw new Error("event exceeds limits");
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		remaining.bytes -= Buffer.byteLength(value);
		if (value.length > MAX_EVENT_BYTES || remaining.bytes < 0)
			throw new Error("event string too large");
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("event number invalid");
		return value;
	}
	if (typeof value !== "object" || seen.has(value))
		throw new Error("event is not JSON");
	seen.add(value);
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.getOwnPropertySymbols(value).length !== 0)
			throw new Error("event symbol");
		if (Array.isArray(value)) {
			if (
				value.length > MAX_EVENTS ||
				Object.keys(descriptors).some(
					(key) => key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key),
				)
			)
				throw new Error("event array invalid");
			return Array.from({ length: value.length }, (_unused, index) => {
				const item = descriptors[String(index)];
				if (item === undefined || !("value" in item))
					throw new Error("event array hole");
				return plainJson(item.value, depth + 1, seen, remaining);
			});
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new Error("event object invalid");
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(descriptors).sort()) {
			const property = descriptors[key];
			remaining.bytes -= Buffer.byteLength(key);
			if (
				key.length > 200 ||
				remaining.bytes < 0 ||
				property === undefined ||
				!("value" in property) ||
				!property.enumerable
			)
				throw new Error("event property invalid");
			result[key] = plainJson(property.value, depth + 1, seen, remaining);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

export function snapshotDistributedData<T>(value: T): T | undefined {
	try {
		const encoded = JSON.stringify(
			plainJson(value, 0, new Set(), { n: 4_096, bytes: 65_536 }),
		);
		if (encoded === undefined || Buffer.byteLength(encoded) > 65_536)
			return undefined;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: plainJson has checked the complete value and preserved its JSON shape.
		return JSON.parse(encoded) as T;
	} catch {
		return undefined;
	}
}

export function encodeDistributedEvent(event: FoldEvent): string | undefined {
	try {
		const data = plainJson(event, 0, new Set(), {
			n: 4_096,
			bytes: MAX_EVENT_BYTES,
		});
		if (!isJsonObject(data) || !isJsonString(data.type) || !name(data.type))
			return undefined;
		const json = JSON.stringify(data);
		return Buffer.byteLength(json) <= MAX_EVENT_BYTES ? json : undefined;
	} catch {
		return undefined;
	}
}

function validState(state: DistributedJournalState): boolean {
	try {
		if (
			state.version !== 1 ||
			!Number.isSafeInteger(state.epoch) ||
			state.epoch < 0 ||
			!Number.isSafeInteger(state.lastNowMs) ||
			state.lastNowMs < 0 ||
			!Array.isArray(state.grants) ||
			!Array.isArray(state.entries) ||
			state.grants.length > MAX_GRANTS ||
			state.entries.length > MAX_EVENTS ||
			state.epoch !== state.grants.length ||
			!Number.isSafeInteger(state.bytes) ||
			state.bytes < 0 ||
			state.bytes > MAX_JOURNAL_BYTES
		)
			return false;
		const grantIds = new Set<string>();
		for (const [index, grant] of state.grants.entries()) {
			if (
				!name(grant.requestId) ||
				!name(grant.holderId) ||
				grant.fenceToken !== index + 1 ||
				!Number.isSafeInteger(grant.expiresAtMs) ||
				grant.expiresAtMs < LEASE_MS ||
				grantIds.has(grant.requestId)
			)
				return false;
			grantIds.add(grant.requestId);
		}
		if (state.current !== null) {
			const latest = state.grants[state.grants.length - 1];
			if (
				latest === undefined ||
				latest.requestId !== state.current.requestId ||
				latest.holderId !== state.current.holderId ||
				latest.fenceToken !== state.current.fenceToken ||
				latest.expiresAtMs !== state.current.expiresAtMs
			)
				return false;
		}
		const eventIds = new Set<string>();
		let bytes = 0;
		for (const [index, entry] of state.entries.entries()) {
			if (
				!name(entry.eventId) ||
				eventIds.has(entry.eventId) ||
				entry.expectedRevision !== index ||
				!isJsonString(entry.eventJson) ||
				entry.eventJson.length > MAX_EVENT_BYTES
			)
				return false;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: persisted JSON is parsed and checked against the canonical event encoder.
			const parsed = JSON.parse(entry.eventJson) as FoldEvent;
			if (encodeDistributedEvent(parsed) !== entry.eventJson) return false;
			bytes += Buffer.byteLength(entry.eventJson);
			eventIds.add(entry.eventId);
		}
		return bytes === state.bytes;
	} catch {
		return false;
	}
}

export function readDistributedJournal(state: DistributedJournalState):
	| { readonly status: "denied"; readonly code: string }
	| {
			readonly status: "ok";
			readonly revision: number;
			readonly events: readonly {
				readonly eventId: string;
				readonly event: FoldEvent;
			}[];
	  } {
	if (!validState(state)) return { status: "denied", code: "CORRUPT_STATE" };
	return {
		status: "ok",
		revision: state.entries.length,
		events: state.entries.map((entry) => ({
			eventId: entry.eventId,
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: validState has parsed and checked every canonical event.
			event: JSON.parse(entry.eventJson) as FoldEvent,
		})),
	};
}

export function transitionDistributedJournal(
	state: DistributedJournalState,
	command: DistributedJournalCommand,
): DistributedJournalTransition {
	const deny = (code: string): DistributedJournalTransition => ({
		state,
		result: { status: "denied", code },
	});
	if (!validState(state)) return deny("CORRUPT_STATE");
	if (
		!Number.isSafeInteger(command.nowMs) ||
		command.nowMs < 0 ||
		!name(command.holderId)
	)
		return deny("INVALID_INPUT");
	if (command.nowMs < state.lastNowMs) return deny("CLOCK_REGRESSION");
	if (command.nowMs > state.lastNowMs)
		state = { ...state, lastNowMs: command.nowMs };
	if (command.kind === "acquire") {
		if (!name(command.requestId)) return deny("INVALID_INPUT");
		const prior = state.grants.find(
			(grant) => grant.requestId === command.requestId,
		);
		if (prior !== undefined) {
			if (prior.holderId !== command.holderId)
				return deny("REQUEST_ID_CONFLICT");
			if (
				state.current?.requestId !== prior.requestId ||
				command.nowMs >= prior.expiresAtMs
			)
				return deny("LEASE_EXPIRED");
			return {
				state,
				result: {
					status: "acquired",
					fenceToken: prior.fenceToken,
					expiresAtMs: prior.expiresAtMs,
					duplicate: true,
				},
			};
		}
		if (state.current !== null && command.nowMs < state.current.expiresAtMs)
			return deny("LEASE_HELD");
		if (
			state.grants.length >= MAX_GRANTS ||
			state.epoch >= Number.MAX_SAFE_INTEGER ||
			command.nowMs > Number.MAX_SAFE_INTEGER - LEASE_MS
		)
			return deny("CAPACITY_EXCEEDED");
		const grant = {
			requestId: command.requestId,
			holderId: command.holderId,
			fenceToken: state.epoch + 1,
			expiresAtMs: command.nowMs + LEASE_MS,
		};
		return {
			state: {
				...state,
				epoch: grant.fenceToken,
				current: grant,
				grants: [...state.grants, grant],
			},
			result: {
				status: "acquired",
				fenceToken: grant.fenceToken,
				expiresAtMs: grant.expiresAtMs,
				duplicate: false,
			},
		};
	}
	if (
		!Number.isSafeInteger(command.fenceToken) ||
		command.fenceToken < 1 ||
		state.current?.holderId !== command.holderId ||
		state.current.requestId !== command.requestId ||
		state.current.fenceToken !== command.fenceToken ||
		command.nowMs >= state.current.expiresAtMs
	)
		return deny("STALE_LEASE");
	if (command.kind === "release")
		return {
			state: { ...state, current: null },
			result: { status: "released" },
		};
	if (command.kind === "check") return { state, result: { status: "valid" } };
	if (command.kind !== "append") return deny("INVALID_INPUT");
	if (
		!name(command.eventId) ||
		!Number.isSafeInteger(command.expectedRevision) ||
		command.expectedRevision < 0
	)
		return deny("INVALID_INPUT");
	const json = encodeDistributedEvent(command.event);
	if (json === undefined) return deny("INVALID_EVENT");
	const index = state.entries.findIndex(
		(entry) => entry.eventId === command.eventId,
	);
	if (index >= 0)
		return state.entries[index]?.eventJson === json &&
			state.entries[index]?.expectedRevision === command.expectedRevision
			? {
					state,
					result: { status: "appended", revision: index + 1, duplicate: true },
				}
			: deny("EVENT_ID_CONFLICT");
	if (command.expectedRevision !== state.entries.length)
		return deny("REVISION_CONFLICT");
	const bytes = Buffer.byteLength(json);
	if (
		state.entries.length >= MAX_EVENTS ||
		state.bytes + bytes > MAX_JOURNAL_BYTES
	)
		return deny("CAPACITY_EXCEEDED");
	return {
		state: {
			...state,
			entries: [
				...state.entries,
				{
					eventId: command.eventId,
					eventJson: json,
					expectedRevision: command.expectedRevision,
				},
			],
			bytes: state.bytes + bytes,
		},
		result: {
			status: "appended",
			revision: state.entries.length + 1,
			duplicate: false,
		},
	};
}
