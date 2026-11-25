type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

const MAX_VERDICT_TTL_MS = 300_000;
const MAX_CLOCK_SKEW_MS = 60_000;

const STATES = ["OPEN", "NO_MEMBER", "NO_CAPACITY", "BUSY"] as const;
type VerdictWireState = (typeof STATES)[number];

function objectOf(value: Json): JsonObject | undefined {
	if (value === null || Array.isArray(value) || !(value instanceof Object))
		return undefined;
	return value;
}

function field(
	object: JsonObject,
	camel: string,
	snake: string,
): Json | undefined {
	if (Object.hasOwn(object, camel)) return object[camel];
	if (Object.hasOwn(object, snake)) return object[snake];
	return undefined;
}

function textOf(value: Json | undefined): string | undefined {
	return value !== undefined && value === String(value) ? value : undefined;
}

function uint32Of(value: Json | undefined): number | undefined {
	if (value === undefined) return 0;
	const text = textOf(value);
	const number =
		text !== undefined && /^[0-9]{1,10}$/u.test(text) ? Number(text) : value;
	return Number.isSafeInteger(number) &&
		Number(number) >= 0 &&
		Number(number) <= 0xffff_ffff
		? Number(number)
		: undefined;
}

function stateOf(value: Json | undefined): VerdictWireState | undefined {
	const text = textOf(value);
	if (text !== undefined)
		return STATES.find((state) => `VERDICT_STATE_${state}` === text);
	return Number.isSafeInteger(value) ? STATES[Number(value) - 1] : undefined;
}

function timeOf(value: Json | undefined): number | undefined {
	const text = textOf(value);
	if (text === undefined) return undefined;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : undefined;
}

export function parseFleetVerdict(
	json: string,
	nowMs: number,
):
	| { state: "OPEN" | "BUSY" | "NO_MEMBER" | "NO_CAPACITY"; freeSlots: number }
	| undefined {
	let parsed: Json;
	try {
		parsed = JSON.parse(json);
	} catch {
		return undefined;
	}
	const verdict = objectOf(parsed);
	if (verdict === undefined) return undefined;
	const state = stateOf(field(verdict, "state", "state"));
	const freeSlots = uint32Of(field(verdict, "freeSlots", "free_slots"));
	const asOfMs = timeOf(field(verdict, "asOf", "as_of"));
	const expiresAtMs = timeOf(field(verdict, "expiresAt", "expires_at"));
	if (
		state === undefined ||
		freeSlots === undefined ||
		asOfMs === undefined ||
		expiresAtMs === undefined
	)
		return undefined;
	if (expiresAtMs <= nowMs) return undefined;
	if (expiresAtMs - asOfMs > MAX_VERDICT_TTL_MS) return undefined;
	if (asOfMs > nowMs + MAX_CLOCK_SKEW_MS) return undefined;
	return { state, freeSlots };
}
