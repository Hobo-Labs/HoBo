import type { JsonValue as PbJsonValue } from "@bufbuild/protobuf";
import {
	type EventInput,
	EventStoreError,
	type JsonObject,
	type JsonValue,
	type PolicyDecision,
	type PrincipalRef,
} from "@hobo/core";
import type { FleetErrorCode } from "../errors.js";
import { FLEET_LOG_EVENTS } from "../events.js";
import { decideGoverned } from "../governed.js";
import type {
	AuthorityDeps,
	FleetFailure,
	FleetLogEvent,
	Outcome,
	VerifiedToken,
} from "../ports.js";

export type FleetDeps = Pick<
	AuthorityDeps,
	| "tenant"
	| "store"
	| "bus"
	| "policy"
	| "decisions"
	| "recordSigner"
	| "now"
	| "log"
> &
	Readonly<{ mode: "authority" | "local" }>;

export const MAX_ATTEMPTS = 8;

export type Person = Extract<VerifiedToken, { kind: "person" }>;
export type Device = Extract<VerifiedToken, { kind: "member" }>;
export type Account = Extract<VerifiedToken, { kind: "account" }>;
export type Workload = Extract<VerifiedToken, { kind: "workload" }>;

/** domain-view: who a governed decision is about (a PolicyRequest subject before the tenant is added). */
export type PolicyActor = Readonly<{
	identity: string;
	tags: readonly string[];
}>;

export function refuse<T>(
	code: FleetErrorCode,
	message: string,
	detail?: Readonly<Record<string, string>>,
): Outcome<T> {
	const error: FleetFailure =
		detail === undefined ? { code, message } : { code, message, detail };
	return { ok: false, error };
}

export function ok<T>(value: T): Outcome<T> {
	return { ok: true, value };
}

export function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

export function actorOf(caller: VerifiedToken): PrincipalRef {
	switch (caller.kind) {
		case "person":
		case "account":
			return caller.principal;
		case "member":
			return { kind: "agent", id: caller.memberId };
		default:
			return { kind: "service", id: `${caller.issuer}#${caller.subject}` };
	}
}

function sameTenant<T extends VerifiedToken>(
	deps: FleetDeps,
	caller: T,
): Outcome<T> {
	return caller.tenant === deps.tenant
		? ok(caller)
		: refuse("forbidden", "the credential is for another tenant");
}

export function asPerson(
	deps: FleetDeps,
	caller: VerifiedToken | undefined,
): Outcome<Person> {
	if (caller === undefined || caller.kind !== "person")
		return refuse("unauthenticated", "this route needs a person token");
	return sameTenant(deps, caller);
}

export function asReader(
	deps: FleetDeps,
	caller: VerifiedToken | undefined,
): Outcome<VerifiedToken> {
	if (caller === undefined || caller.kind === "workload")
		return refuse("unauthenticated", "this route needs a credential");
	return sameTenant(deps, caller);
}

export function subjectOf(caller: Person | Account): PolicyActor {
	return caller.kind === "person"
		? { identity: principalKey(caller.principal), tags: caller.tags }
		: { identity: principalKey(caller.principal), tags: caller.scopes };
}

export function governed(
	deps: FleetDeps,
	subject: PolicyActor,
	action: string,
	resource: Readonly<{ kind: string; id: string; fleet: string }>,
): Promise<Outcome<PolicyDecision>> {
	return decideGoverned(deps, {
		subject: {
			identity: subject.identity,
			tenantId: deps.tenant,
			tags: subject.tags,
		},
		action,
		resource: {
			kind: resource.kind,
			id: resource.id,
			tenantId: deps.tenant,
			attributes: { fleet: resource.fleet },
		},
	});
}

export async function append(
	deps: FleetDeps,
	stream: string,
	expectedSeq: number,
	events: readonly EventInput<JsonObject>[],
	actor: PrincipalRef,
): Promise<"appended" | "conflict"> {
	try {
		await deps.store.append(stream, [...events], {
			expectedSeq,
			actor,
			tenant: deps.tenant,
		});
		return "appended";
	} catch (error) {
		if (
			error instanceof EventStoreError &&
			error.code === "OPTIMISTIC_SEQUENCE_CONFLICT"
		)
			return "conflict";
		throw error;
	}
}

export function iso(ms: number): string {
	return new Date(ms).toISOString();
}

const LOG_NAMES: ReadonlySet<string> = new Set(FLEET_LOG_EVENTS);

export function logNameOf(type: string): FleetLogEvent | undefined {
	const name = `hobo_fleet_${type
		.replace(/^fleet\./u, "")
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()}`;
	return LOG_NAMES.has(name)
		? FLEET_LOG_EVENTS.find((candidate) => candidate === name)
		: undefined;
}

export function logEvent(deps: FleetDeps, type: string, subject: string): void {
	const name = logNameOf(type);
	if (name !== undefined) deps.log(name, { subject, tenant: deps.tenant });
}

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function pbJson(value: PbJsonValue): JsonValue {
	return value;
}

export function textOf(data: JsonObject, field: string): string {
	const value = data[field];
	return isJsonString(value) ? value : "";
}

export function countOf(data: JsonObject, field: string): number {
	const value = data[field];
	return isJsonNumber(value) ? value : 0;
}
