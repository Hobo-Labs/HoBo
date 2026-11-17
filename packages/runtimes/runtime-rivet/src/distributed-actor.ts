import { randomUUID } from "node:crypto";
import type {
	AsyncActorLease,
	AsyncActorLeaseHost,
	FoldEvent,
} from "@hobo/core";
import { type AnyActorDefinition, actor } from "rivetkit";
import {
	type DistributedJournalCommand,
	type DistributedJournalResult,
	type DistributedJournalState,
	encodeDistributedEvent,
	initialDistributedJournal,
	readDistributedJournal,
	transitionDistributedJournal,
} from "./distributed-journal.js";

interface ActorVars {
	tail: Promise<void>;
	poisoned: boolean;
}
interface JournalActorContext {
	state: DistributedJournalState;
	vars: ActorVars;
	saveState(options: { immediate: true }): Promise<void>;
}
type RemoteDecision =
	| DistributedJournalResult
	| { readonly status: "uncertain"; readonly code: string };
type LeaseInput = {
	readonly holderId: string;
	readonly requestId: string;
	readonly fenceToken: number;
};
type AppendInput = LeaseInput & {
	readonly eventId: string;
	readonly expectedRevision: number;
	readonly event: FoldEvent;
};

function exclusive<T>(
	context: JournalActorContext,
	work: () => Promise<T>,
): Promise<T> {
	const result = context.vars.tail.then(work);
	context.vars.tail = result.then(
		() => {},
		() => {},
	);
	return result;
}

async function perform(
	context: JournalActorContext,
	command: DistributedJournalCommand,
): Promise<RemoteDecision> {
	return exclusive(context, async () => {
		if (context.vars.poisoned)
			return { status: "uncertain", code: "PERSISTENCE_OUTCOME_UNKNOWN" };
		let transition: ReturnType<typeof transitionDistributedJournal>;
		const current = context.state;
		try {
			transition = transitionDistributedJournal(current, command);
		} catch {
			return { status: "denied", code: "INVALID_INPUT" };
		}
		if (transition.state === current) return transition.result;
		context.state = transition.state;
		try {
			await context.saveState({ immediate: true });
			return transition.result;
		} catch {
			context.vars.poisoned = true;
			return { status: "uncertain", code: "PERSISTENCE_OUTCOME_UNKNOWN" };
		}
	});
}

/** A real RivetKit actor; each compound key owns one durable fenced journal. */
export const rivetDistributedJournalActor: AnyActorDefinition = actor({
	createState: () => initialDistributedJournal(),
	createVars: (): ActorVars => ({ tail: Promise.resolve(), poisoned: false }),
	actions: {
		acquire: (context, input: { holderId: string; requestId: string }) =>
			perform(context, { kind: "acquire", ...input, nowMs: Date.now() }),
		check: (context, input: LeaseInput) =>
			perform(context, { kind: "check", ...input, nowMs: Date.now() }),
		release: (context, input: LeaseInput) =>
			perform(context, { kind: "release", ...input, nowMs: Date.now() }),
		append: (context, input: AppendInput) =>
			perform(context, { kind: "append", ...input, nowMs: Date.now() }),
		read: (context) =>
			exclusive(context, async () => {
				if (context.vars.poisoned)
					return {
						status: "uncertain" as const,
						code: "PERSISTENCE_OUTCOME_UNKNOWN",
					};
				return readDistributedJournal(context.state);
			}),
	},
});

interface RemoteRead {
	readonly status: "ok" | "denied" | "uncertain";
	readonly code?: string;
	readonly revision?: number;
	readonly events?: readonly {
		readonly eventId: string;
		readonly event: FoldEvent;
	}[];
}
interface RivetJournalHandle {
	acquire(input: {
		holderId: string;
		requestId: string;
	}): Promise<RemoteDecision>;
	check(input: LeaseInput): Promise<RemoteDecision>;
	release(input: LeaseInput): Promise<RemoteDecision>;
	append(input: AppendInput): Promise<RemoteDecision>;
	read(): Promise<RemoteRead>;
}
export interface RivetJournalNamespace {
	getOrCreate(key: string[]): RivetJournalHandle;
}

export class RivetDistributedJournalError extends Error {
	readonly requiresReconciliation: boolean;

	constructor(
		readonly code: string,
		readonly operation: "acquire" | "check" | "release" | "append" | "read",
		readonly requestId?: string,
	) {
		super(`${code}: Rivet journal ${operation}`);
		this.name = "RivetDistributedJournalError";
		this.requiresReconciliation =
			operation !== "read" && code === "OUTCOME_UNKNOWN";
	}
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: identities cross the Rivet RPC boundary. */
function validName(value: string): boolean {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- SAFETY: RPC receipts may be malformed, mutable or contain accessors; copy only bounded own data properties. */
function readDecision(input: unknown): RemoteDecision | undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const value = (key: string): unknown => {
			const property = properties[key];
			if (property === undefined || !("value" in property))
				throw new Error("invalid receipt");
			return property.value;
		};
		const status = value("status");
		if (status === "denied" || status === "uncertain") {
			const code = value("code");
			return typeof code === "string" && validName(code)
				? { status, code }
				: undefined;
		}
		if (status === "valid" || status === "released") return { status };
		if (status === "acquired") {
			const fenceToken = value("fenceToken");
			const expiresAtMs = value("expiresAtMs");
			const duplicate = value("duplicate");
			if (
				typeof fenceToken !== "number" ||
				!Number.isSafeInteger(fenceToken) ||
				fenceToken < 1 ||
				typeof expiresAtMs !== "number" ||
				!Number.isSafeInteger(expiresAtMs) ||
				expiresAtMs <= 0 ||
				expiresAtMs > 8_640_000_000_000_000 ||
				typeof duplicate !== "boolean"
			)
				return undefined;
			return { status, fenceToken, expiresAtMs, duplicate };
		}
		if (status === "appended") {
			const revision = value("revision");
			const duplicate = value("duplicate");
			if (
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 1 ||
				revision > 1_024 ||
				typeof duplicate !== "boolean"
			)
				return undefined;
			return { status, revision, duplicate };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function readSnapshot(
	input: unknown,
):
	| { revision: number; events: { eventId: string; event: FoldEvent }[] }
	| undefined {
	try {
		if (typeof input !== "object" || input === null || Array.isArray(input))
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		const status = properties.status;
		const revision = properties.revision;
		const events = properties.events;
		if (
			status === undefined ||
			!("value" in status) ||
			status.value !== "ok" ||
			revision === undefined ||
			!("value" in revision) ||
			typeof revision.value !== "number" ||
			!Number.isSafeInteger(revision.value) ||
			revision.value < 0 ||
			revision.value > 1_024 ||
			events === undefined ||
			!("value" in events) ||
			!Array.isArray(events.value) ||
			events.value.length !== revision.value
		)
			return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(events.value);
		const result: { eventId: string; event: FoldEvent }[] = [];
		let bytes = 0;
		const ids = new Set<string>();
		for (let index = 0; index < events.value.length; index++) {
			const item = descriptors[String(index)];
			if (
				item === undefined ||
				!("value" in item) ||
				typeof item.value !== "object" ||
				item.value === null ||
				Array.isArray(item.value)
			)
				return undefined;
			const fields = Object.getOwnPropertyDescriptors(item.value);
			const eventId = fields.eventId;
			const event = fields.event;
			if (
				eventId === undefined ||
				!("value" in eventId) ||
				typeof eventId.value !== "string" ||
				!validName(eventId.value) ||
				ids.has(eventId.value) ||
				event === undefined ||
				!("value" in event)
			)
				return undefined;
			const encoded = encodeDistributedEvent(event.value);
			if (encoded === undefined) return undefined;
			bytes += Buffer.byteLength(encoded);
			if (bytes > 4_194_304) return undefined;
			// SAFETY: the canonical encoder accepts only a bounded valid FoldEvent.
			result.push({
				eventId: eventId.value,
				event: JSON.parse(encoded) as FoldEvent,
			});
			ids.add(eventId.value);
		}
		return { revision: revision.value, events: result };
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

/** Shared lease and journal client. Credentials must be scoped by the host. */
export function createRivetDistributedJournal(
	namespace: RivetJournalNamespace,
	scope: { tenantId: string; campId: string },
) {
	if (!validName(scope.tenantId) || !validName(scope.campId))
		throw new TypeError("invalid Rivet journal scope");
	const tenantId = scope.tenantId;
	const campId = scope.campId;
	const capabilities = new WeakMap<AsyncActorLease, LeaseInput>();
	const handle = (key: string) => {
		if (!validName(key)) throw new TypeError("invalid Rivet actor key");
		return namespace.getOrCreate(["hobo", tenantId, campId, key]);
	};
	const request = async (
		operation: RivetDistributedJournalError["operation"],
		requestId: string | undefined,
		run: () => Promise<RemoteDecision>,
	): Promise<RemoteDecision> => {
		let raw: unknown;
		try {
			raw = await run();
		} catch {
			throw new RivetDistributedJournalError(
				"OUTCOME_UNKNOWN",
				operation,
				requestId,
			);
		}
		const response = readDecision(raw);
		if (response === undefined)
			throw new RivetDistributedJournalError(
				"OUTCOME_UNKNOWN",
				operation,
				requestId,
			);
		if (response.status === "uncertain")
			throw new RivetDistributedJournalError(
				"OUTCOME_UNKNOWN",
				operation,
				requestId,
			);
		if (response.status === "denied")
			throw new RivetDistributedJournalError(
				response.code,
				operation,
				requestId,
			);
		return response;
	};
	const acquireWithRequest = async (
		key: string,
		input: { holderId: string; requestId: string },
	): Promise<AsyncActorLease> => {
		if (!validName(input.holderId) || !validName(input.requestId))
			throw new TypeError("invalid Rivet lease request");
		const remote = handle(key);
		const granted = await request("acquire", input.requestId, () =>
			remote.acquire(input),
		);
		if (
			granted.status !== "acquired" ||
			!Number.isSafeInteger(granted.fenceToken) ||
			granted.fenceToken < 1 ||
			!Number.isSafeInteger(granted.expiresAtMs)
		)
			throw new RivetDistributedJournalError(
				"OUTCOME_UNKNOWN",
				"acquire",
				input.requestId,
			);
		const capability = {
			holderId: input.holderId,
			requestId: input.requestId,
			fenceToken: granted.fenceToken,
		};
		const lease: AsyncActorLease = Object.freeze({
			key,
			holderId: input.holderId,
			fenceToken: BigInt(granted.fenceToken),
			expiresAt: new Date(granted.expiresAtMs).toISOString(),
			async revalidate() {
				const response = await request("check", input.requestId, () =>
					remote.check(capability),
				);
				if (response.status !== "valid")
					throw new RivetDistributedJournalError(
						"INVALID_RECEIPT",
						"check",
						input.requestId,
					);
			},
			async release() {
				const response = await request("release", input.requestId, () =>
					remote.release(capability),
				);
				if (response.status !== "released")
					throw new RivetDistributedJournalError(
						"OUTCOME_UNKNOWN",
						"release",
						input.requestId,
					);
			},
		});
		capabilities.set(lease, capability);
		return lease;
	};
	const actorHost: AsyncActorLeaseHost = {
		acquire: (key, input) =>
			acquireWithRequest(key, {
				holderId: input.holderId,
				requestId: randomUUID(),
			}),
	};
	return {
		actorHost,
		acquireWithRequest,
		async append(
			key: string,
			lease: AsyncActorLease,
			input: { eventId: string; expectedRevision: number; event: FoldEvent },
		) {
			const capability = capabilities.get(lease);
			if (capability === undefined || lease.key !== key)
				throw new RivetDistributedJournalError("STALE_LEASE", "append");
			const remote = handle(key);
			const response = await request("append", capability.requestId, () =>
				remote.append({ ...capability, ...input }),
			);
			if (
				response.status !== "appended" ||
				!Number.isSafeInteger(response.revision) ||
				response.revision < 1
			)
				throw new RivetDistributedJournalError(
					"OUTCOME_UNKNOWN",
					"append",
					capability.requestId,
				);
			return response;
		},
		async read(key: string) {
			let raw: unknown;
			try {
				raw = await handle(key).read();
			} catch {
				throw new RivetDistributedJournalError("UNAVAILABLE", "read");
			}
			const result = readSnapshot(raw);
			if (result === undefined)
				throw new RivetDistributedJournalError("UNAVAILABLE", "read");
			return result;
		},
	};
}
