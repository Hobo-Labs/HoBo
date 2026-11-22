import {
	type EventEnvelope,
	type JsonObject,
	type JsonValue,
	OptimisticSequenceConflictError,
	type PrincipalRef,
} from "@hobo/core";
import type { FleetEventStore } from "../ports.js";

// public-contract: the stream id prefixes of §7.5.
export const SIGN_IN_STREAM_PREFIX = "fleet-signin-";
// public-contract: the stream id prefixes of §7.5.
export const PERSON_STREAM_PREFIX = "fleet-person-";

/** domain-view: the stored form of `SignInStart`, plus what the authority adds at start. */
export type Started = Readonly<{
	provider: string;
	redirectUri: string;
	codeChallenge: string;
	dpopThumbprint: string;
	deviceFlow: boolean;
	hostName: string;
	deviceName: string;
	platformOs: string;
	platformArch: string;
	providerVerifier: string;
	expiresAtMs: number;
}>;

export type Authenticated = Readonly<{
	principal: PrincipalRef;
	tags: readonly string[];
}>;

export type Decided = Readonly<{ approved: boolean; codeDigest: string }>;

export type SignInStep = Readonly<
	| { step: "started"; started: Started }
	| { step: "authenticated"; started: Started; person: Authenticated }
	| {
			step: "decided";
			started: Started;
			person: Authenticated;
			decision: Decided;
	  }
	| {
			step: "completed";
			started: Started;
			person: Authenticated;
			decision: Decided;
	  }
>;

export const STEP_HEAD = {
	started: 1,
	authenticated: 2,
	decided: 3,
	completed: 4,
} as const;

const SYSTEM_ACTOR: PrincipalRef = { kind: "system", id: "hobo-fleet-signin" };

export function signInStream(state: string): string {
	return `${SIGN_IN_STREAM_PREFIX}${state}`;
}

export async function readSignIn(
	store: FleetEventStore,
	state: string,
): Promise<SignInStep | undefined> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(signInStream(state))) events.push(event);
	return foldSignIn(events);
}

export function foldSignIn(
	events: readonly EventEnvelope[],
): SignInStep | undefined {
	let current: SignInStep | undefined;
	for (const event of events) {
		const data = objectOf(event.data);
		if (data === undefined) return undefined;
		if (event.type === "fleet.SignInStarted" && current === undefined) {
			const started = startedOf(data);
			if (started === undefined) return undefined;
			current = { step: "started", started };
		} else if (
			event.type === "fleet.SignInAuthenticated" &&
			current?.step === "started"
		) {
			const person = personOf(data);
			if (person === undefined) return undefined;
			current = { step: "authenticated", started: current.started, person };
		} else if (
			event.type === "fleet.SignInApproved" &&
			current?.step === "authenticated"
		) {
			const approved = data.approved;
			const codeDigest = data.codeDigest;
			if (!isBoolean(approved) || !isString(codeDigest)) return undefined;
			current = {
				step: "decided",
				started: current.started,
				person: current.person,
				decision: { approved, codeDigest },
			};
		} else if (
			event.type === "fleet.SignInCompleted" &&
			current?.step === "decided"
		) {
			current = { ...current, step: "completed" };
		} else {
			return undefined;
		}
	}
	return current;
}

export function startedData(started: Started): JsonObject {
	return { ...started };
}

export function authenticatedData(person: Authenticated): JsonObject {
	return {
		principalKind: person.principal.kind,
		principalId: person.principal.id,
		tags: [...person.tags],
	};
}

export type AppendStep =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; conflict: boolean; message: string }>;

export async function appendAt(
	store: FleetEventStore,
	streamId: string,
	expectedSeq: number,
	tenant: string,
	event: Readonly<{ type: string; data: JsonObject }>,
	actor: PrincipalRef = SYSTEM_ACTOR,
): Promise<AppendStep> {
	try {
		await store.append(streamId, [{ type: event.type, data: event.data }], {
			expectedSeq,
			actor,
			tenant,
		});
		return { ok: true };
	} catch (error) {
		if (error instanceof OptimisticSequenceConflictError)
			return { ok: false, conflict: true, message: error.message };
		return {
			ok: false,
			conflict: false,
			message: error instanceof Error ? error.message : "the store failed",
		};
	}
}

export async function appendAtHead(
	store: FleetEventStore,
	streamId: string,
	tenant: string,
	event: Readonly<{ type: string; data: JsonObject; idempotencyKey: string }>,
	actor: PrincipalRef,
): Promise<AppendStep> {
	let last: AppendStep = { ok: false, conflict: true, message: "no attempt" };
	for (let attempt = 0; attempt < 8; attempt += 1) {
		let head = 0;
		for await (const _ of store.read(streamId)) head += 1;
		try {
			await store.append(
				streamId,
				[
					{
						type: event.type,
						data: event.data,
						meta: { idempotencyKey: event.idempotencyKey },
					},
				],
				{ expectedSeq: head, actor, tenant },
			);
			return { ok: true };
		} catch (error) {
			if (!(error instanceof OptimisticSequenceConflictError))
				return {
					ok: false,
					conflict: false,
					message: error instanceof Error ? error.message : "the store failed",
				};
			last = { ok: false, conflict: true, message: error.message };
		}
	}
	return last;
}

/** domain-view: the stored `fleet.PersonSignedIn`, which bounds refresh. */
export type PersonSignIn = Readonly<{
	jkt: string;
	refreshUntilMs: number;
	tags: readonly string[];
}>;

export async function readPersonSignIns(
	store: FleetEventStore,
	streamId: string,
): Promise<readonly PersonSignIn[]> {
	const out: PersonSignIn[] = [];
	for await (const event of store.read(streamId)) {
		if (event.type !== "fleet.PersonSignedIn") continue;
		const data = objectOf(event.data);
		const jkt = data?.jkt;
		const refreshUntilMs = data?.refreshUntilMs;
		const tags = stringsOf(data?.tags);
		if (isString(jkt) && isNumber(refreshUntilMs) && tags !== undefined)
			out.push({ jkt, refreshUntilMs, tags });
	}
	return out;
}

function startedOf(data: JsonObject): Started | undefined {
	const {
		provider,
		redirectUri,
		codeChallenge,
		dpopThumbprint,
		deviceFlow,
		hostName,
		deviceName,
		platformOs,
		platformArch,
		providerVerifier,
		expiresAtMs,
	} = data;
	if (
		!isString(provider) ||
		!isString(redirectUri) ||
		!isString(codeChallenge) ||
		!isString(dpopThumbprint) ||
		!isBoolean(deviceFlow) ||
		!isString(hostName) ||
		!isString(deviceName) ||
		!isString(platformOs) ||
		!isString(platformArch) ||
		!isString(providerVerifier) ||
		!isNumber(expiresAtMs)
	)
		return undefined;
	return {
		provider,
		redirectUri,
		codeChallenge,
		dpopThumbprint,
		deviceFlow,
		hostName,
		deviceName,
		platformOs,
		platformArch,
		providerVerifier,
		expiresAtMs,
	};
}

function personOf(data: JsonObject): Authenticated | undefined {
	const { principalKind, principalId } = data;
	const tags = stringsOf(data.tags);
	if (!isString(principalId) || tags === undefined) return undefined;
	const principal = principalRef(principalKind, principalId);
	return principal === undefined ? undefined : { principal, tags };
}

export function principalRef(
	kind: JsonValue | undefined,
	id: string,
): PrincipalRef | undefined {
	return kind === "user" ||
		kind === "agent" ||
		kind === "service" ||
		kind === "system"
		? { kind, id }
		: undefined;
}

const tagOf = Object.prototype.toString;

function isObject<T>(value: T): value is T & JsonObject {
	return (
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

function objectOf<T>(value: T): JsonObject | undefined {
	return isObject(value) ? value : undefined;
}

function isString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

function isNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}

function isBoolean(value: JsonValue | undefined): value is boolean {
	return value === true || value === false;
}

function stringsOf(value: JsonValue | undefined): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: string[] = [];
	for (const item of value) {
		if (!isString(item)) return undefined;
		out.push(item);
	}
	return out;
}
