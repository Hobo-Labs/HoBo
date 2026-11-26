// Parse-don't-validate boundary of the CD read API (WP12). A raw request
// becomes a `CdReadRoute` whose ids, enums and positions are already parsed;
// nothing past this module re-checks a string. Paths that are not read
// routes parse to `{kind: "feed"}` and go to the delivery feed unchanged.
import type { EventPosition } from "@hobo/core";
import {
	type CampConditionType,
	CampConditionTypeSchema,
	ConditionStatus,
	ConditionStatusSchema,
	type FailoverState,
	FailoverStateSchema,
	type TaintEffect,
	TaintEffectSchema,
} from "../_generated/cd_pb.js";
import type {
	CampId,
	Digest,
	FanoutId,
	FeedRequest,
	Outcome,
} from "../ports.js";
import { serviceRefusal } from "./errors.js";

/** A path segment: 1–256 printable chars, no slash, not `.`/`..`. */
export type PathName = string & { readonly __brand: "cd.service.PathName" };

export type ConditionFilter = Readonly<{
	type: CampConditionType;
	status: ConditionStatus;
}>;
export type TaintFilter = Readonly<{ effect: TaintEffect } | { key: string }>;

export const PROMOTIONS_DEFAULT_LIMIT = 100;
export const PROMOTIONS_MAX_LIMIT = 1_000;

export type CdReadRoute =
	| Readonly<{ kind: "openapi" }>
	| Readonly<{ kind: "ready" }>
	| Readonly<{ kind: "pipeline"; name: PathName }>
	| Readonly<{ kind: "freight"; idOrAlias: PathName }>
	| Readonly<{ kind: "promotions"; campId: CampId | undefined; limit: number }>
	| Readonly<{ kind: "campStatus"; campId: CampId }>
	| Readonly<{
			kind: "camps";
			set: PathName | undefined;
			taint: TaintFilter | undefined;
			condition: ConditionFilter | undefined;
	  }>
	| Readonly<{ kind: "campInventory"; campId: CampId }>
	| Readonly<{
			kind: "placementDecision";
			placement: PathName;
			decisionId: PathName;
	  }>
	| Readonly<{ kind: "fanout"; fanoutId: FanoutId }>
	| Readonly<{ kind: "failovers"; state: FailoverState | undefined }>
	| Readonly<{
			kind: "compliance";
			campId: CampId | undefined;
			railDigest: Digest | undefined;
	  }>
	| Readonly<{
			kind: "stream";
			after: EventPosition | undefined;
			types: ReadonlySet<string> | undefined;
	  }>;

export type ParsedRequest =
	| Readonly<{ kind: "feed" }>
	| Readonly<{ kind: "read"; route: CdReadRoute; name: string }>;

const PATTERNS: readonly (readonly [RegExp, string])[] = [
	[/^\/v1\/cd\/openapi\.json$/, "openapi"],
	[/^\/v1\/cd\/ready$/, "ready"],
	[/^\/v1\/cd\/pipelines\/([^/]+)$/, "pipeline"],
	[/^\/v1\/cd\/freight\/([^/]+)$/, "freight"],
	[/^\/v1\/cd\/promotions$/, "promotions"],
	[/^\/v1\/cd\/camps$/, "camps"],
	[/^\/v1\/cd\/camps\/([^/]+)\/status$/, "campStatus"],
	[/^\/v1\/cd\/camps\/([^/]+)\/inventory$/, "campInventory"],
	[/^\/v1\/cd\/placements\/([^/]+)\/decisions\/([^/]+)$/, "placementDecision"],
	[/^\/v1\/cd\/fanouts\/([^/]+)$/, "fanout"],
	[/^\/v1\/cd\/failovers$/, "failovers"],
	[/^\/v1\/cd\/compliance$/, "compliance"],
	[/^\/v1\/cd\/stream$/, "stream"],
];

/** Route names as metric attributes (no ids, bounded cardinality). */
export const READ_ROUTE_NAMES = Object.freeze(PATTERNS.map(([, name]) => name));

const PRINTABLE = /^[\x21-\x7e]+$/;

export function parsePathName(raw: string, subject: string): Outcome<PathName> {
	let value: string;
	try {
		value = decodeURIComponent(raw);
	} catch {
		return serviceRefusal(
			"query-invalid",
			`${subject} is not valid percent-encoding`,
			subject,
		);
	}
	if (
		value.length === 0 ||
		value.length > 256 ||
		!PRINTABLE.test(value) ||
		value.includes("/") ||
		value === "." ||
		value === ".."
	) {
		return serviceRefusal(
			"query-invalid",
			`${subject} must be 1–256 printable characters without '/'`,
			subject,
		);
	}
	// SAFETY: the checks above are exactly the PathName invariant.
	return { ok: true, value: value as PathName };
}

function parseEnum<E extends number>(
	schema: Readonly<{
		values: readonly Readonly<{
			number: number;
			name: string;
			localName: string;
		}>[];
	}>,
	raw: string,
): E | undefined {
	const upper = raw.trim().toUpperCase();
	const found = schema.values.find(
		(v) => v.number !== 0 && (v.name === upper || v.localName === upper),
	);
	// SAFETY: `found` is a value of the enum schema E was instantiated with.
	return found === undefined ? undefined : (found.number as E);
}

function names(
	schema: Readonly<{
		values: readonly Readonly<{ number: number; localName: string }>[];
	}>,
): string {
	return schema.values
		.filter((v) => v.number !== 0)
		.map((v) => v.localName)
		.join(", ");
}

export function parseCondition(raw: string): Outcome<ConditionFilter> {
	const [typeRaw = "", statusRaw] = raw.split("=", 2);
	const type = parseEnum<CampConditionType>(CampConditionTypeSchema, typeRaw);
	if (type === undefined) {
		return serviceRefusal(
			"query-invalid",
			`condition must be one of ${names(CampConditionTypeSchema)} (optionally =true|false|unknown)`,
			"condition",
		);
	}
	if (statusRaw === undefined)
		return { ok: true, value: { type, status: ConditionStatus.TRUE } };
	const status = parseEnum<ConditionStatus>(ConditionStatusSchema, statusRaw);
	if (status === undefined) {
		return serviceRefusal(
			"query-invalid",
			`condition status must be one of ${names(ConditionStatusSchema)}`,
			"condition",
		);
	}
	return { ok: true, value: { type, status } };
}

export function parseTaint(raw: string): Outcome<TaintFilter> {
	const effect = parseEnum<TaintEffect>(TaintEffectSchema, raw);
	if (effect !== undefined) return { ok: true, value: { effect } };
	const key = parsePathNameLoose(raw);
	if (key === undefined)
		return serviceRefusal(
			"query-invalid",
			"taint must be NO_PLACE, NO_RUN or a taint key",
			"taint",
		);
	return { ok: true, value: { key } };
}

function parsePathNameLoose(raw: string): string | undefined {
	return raw.length > 0 && raw.length <= 256 && PRINTABLE.test(raw)
		? raw
		: undefined;
}

export function parseFailoverState(raw: string): Outcome<FailoverState> {
	const state = parseEnum<FailoverState>(FailoverStateSchema, raw);
	return state === undefined
		? serviceRefusal(
				"query-invalid",
				`state must be one of ${names(FailoverStateSchema)}`,
				"state",
			)
		: { ok: true, value: state };
}

const DIGEST = /^sha256:[0-9a-f]{1,64}$/;

export function parseDigest(raw: string, subject: string): Outcome<Digest> {
	return DIGEST.test(raw)
		? // SAFETY: DIGEST matched, which is the Digest invariant.
			{ ok: true, value: raw as Digest }
		: serviceRefusal(
				"query-invalid",
				`${subject} must be a sha256:<hex> digest`,
				subject,
			);
}

const POSITION = /^(0|[1-9][0-9]{0,19})$/;

export function parsePosition(raw: string): Outcome<EventPosition> {
	if (!POSITION.test(raw)) {
		return serviceRefusal(
			"last-event-id-invalid",
			"Last-Event-ID must be a non-negative decimal journal position",
			"last-event-id",
		);
	}
	const value = BigInt(raw);
	if (value > 0xffff_ffff_ffff_ffffn) {
		return serviceRefusal(
			"last-event-id-invalid",
			"Last-Event-ID exceeds a 64-bit position",
			"last-event-id",
		);
	}
	// SAFETY: a non-negative decimal within 64 bits is a valid EventPosition.
	return { ok: true, value: value as EventPosition };
}

function parseLimit(raw: string | null): Outcome<number> {
	if (raw === null) return { ok: true, value: PROMOTIONS_DEFAULT_LIMIT };
	const n = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isInteger(n) || n < 1 || n > PROMOTIONS_MAX_LIMIT) {
		return serviceRefusal(
			"query-invalid",
			`limit must be an integer from 1 to ${PROMOTIONS_MAX_LIMIT}`,
			"limit",
		);
	}
	return { ok: true, value: n };
}

function header(request: FeedRequest, name: string): string | undefined {
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(request.headers))
		if (k.toLowerCase() === want) return v;
	return undefined;
}

function optional<T>(
	raw: string | null,
	parse: (raw: string) => Outcome<T>,
): Outcome<T | undefined> {
	if (raw === null || raw === "") return { ok: true, value: undefined };
	return parse(raw);
}

function asFanout(name: PathName): FanoutId {
	const raw: string = name;
	// SAFETY: a parsed PathName satisfies the FanoutId invariant (non-empty, printable, no slash).
	return raw as FanoutId;
}

function asCamp(o: Outcome<PathName>): Outcome<CampId> {
	// SAFETY: a parsed PathName satisfies the CampId invariant (non-empty, printable, no slash).
	return o as Outcome<CampId>;
}

/** Parse a raw `/v1/cd/` request into a read route, or `feed` for everything else. */
export function parseReadRequest(request: FeedRequest): Outcome<ParsedRequest> {
	const url = new URL(request.path, "http://cd.invalid");
	const path = url.pathname;
	const match = PATTERNS.map(
		([re, name]) => [re.exec(path), name] as const,
	).find(([m]) => m !== null);
	if (!match) return { ok: true, value: { kind: "feed" } };
	const [m, name] = match;
	if (m === null) return { ok: true, value: { kind: "feed" } };
	if (request.method.toUpperCase() !== "GET") {
		return serviceRefusal(
			"method-not-allowed",
			`${request.method} ${path} is not allowed; the CD read API is GET only`,
			path,
		);
	}
	const q = url.searchParams;
	const route = parseRoute(name, m, q, request);
	if (!route.ok) return route;
	return { ok: true, value: { kind: "read", route: route.value, name } };
}

function parseRoute(
	name: string,
	m: RegExpExecArray,
	q: URLSearchParams,
	request: FeedRequest,
): Outcome<CdReadRoute> {
	const p1 = m[1] ?? "";
	const p2 = m[2] ?? "";
	switch (name) {
		case "openapi":
			return { ok: true, value: { kind: "openapi" } };
		case "ready":
			return { ok: true, value: { kind: "ready" } };
		case "pipeline": {
			const n = parsePathName(p1, "name");
			return n.ok
				? { ok: true, value: { kind: "pipeline", name: n.value } }
				: n;
		}
		case "freight": {
			const n = parsePathName(p1, "id");
			return n.ok
				? { ok: true, value: { kind: "freight", idOrAlias: n.value } }
				: n;
		}
		case "promotions": {
			const camp = optional(q.get("camp"), (r) =>
				asCamp(parsePathName(r, "camp")),
			);
			if (!camp.ok) return camp;
			const limit = parseLimit(q.get("limit"));
			if (!limit.ok) return limit;
			return {
				ok: true,
				value: {
					kind: "promotions",
					limit: limit.value,
					campId: camp.value,
				},
			};
		}
		case "camps": {
			const set = optional(q.get("set"), (r) => parsePathName(r, "set"));
			if (!set.ok) return set;
			const taint = optional(q.get("taint"), parseTaint);
			if (!taint.ok) return taint;
			const condition = optional(q.get("condition"), parseCondition);
			if (!condition.ok) return condition;
			return {
				ok: true,
				value: {
					kind: "camps",
					set: set.value,
					taint: taint.value,
					condition: condition.value,
				},
			};
		}
		case "campStatus":
		case "campInventory": {
			const c = asCamp(parsePathName(p1, "id"));
			if (!c.ok) return c;
			return {
				ok: true,
				value:
					name === "campStatus"
						? { kind: "campStatus", campId: c.value }
						: { kind: "campInventory", campId: c.value },
			};
		}
		case "placementDecision": {
			const placement = parsePathName(p1, "name");
			if (!placement.ok) return placement;
			const decision = parsePathName(p2, "id");
			if (!decision.ok) return decision;
			return {
				ok: true,
				value: {
					kind: "placementDecision",
					placement: placement.value,
					decisionId: decision.value,
				},
			};
		}
		case "fanout": {
			const f = parsePathName(p1, "id");
			return f.ok
				? {
						ok: true,
						value: { kind: "fanout", fanoutId: asFanout(f.value) },
					}
				: f;
		}
		case "failovers": {
			const state = optional(q.get("state"), parseFailoverState);
			if (!state.ok) return state;
			return {
				ok: true,
				value: {
					kind: "failovers",
					state: state.value,
				},
			};
		}
		case "compliance": {
			const camp = optional(q.get("camp"), (r) =>
				asCamp(parsePathName(r, "camp")),
			);
			if (!camp.ok) return camp;
			const rail = optional(q.get("rail"), (r) => parseDigest(r, "rail"));
			if (!rail.ok) return rail;
			return {
				ok: true,
				value: {
					kind: "compliance",
					campId: camp.value,
					railDigest: rail.value,
				},
			};
		}
		default: {
			// stream
			const lastEventId =
				header(request, "last-event-id") ?? q.get("after") ?? undefined;
			const after =
				lastEventId === undefined || lastEventId === ""
					? undefined
					: parsePosition(lastEventId.trim());
			if (after && !after.ok) return after;
			const typesRaw = q.get("types");
			const types = typesRaw
				? new Set(
						typesRaw
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean),
					)
				: undefined;
			return {
				ok: true,
				value: {
					kind: "stream",
					after: after?.value,
					types,
				},
			};
		}
	}
}
