import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import type {
	AsyncActorLease,
	AsyncActorLeaseHost,
	FoldEvent,
} from "@hobo/core";
import {
	computeRivetOperationDigest,
	type RivetJournalAction,
	type RivetOperation,
	type RivetSignedCapability,
} from "./distributed-auth.js";
import {
	type DistributedJournalResult,
	encodeDistributedEvent,
	snapshotDistributedData,
} from "./distributed-journal.js";

export { createRivetSqlJournalActor as createRivetDistributedJournalActor } from "./distributed-sql.js";

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
type ReadInput = {
	readonly afterRevision: number;
	readonly limit: number;
	readonly throughRevision?: number;
};
type AuthorizedInput<T> = {
	readonly args: T;
	readonly capability: RivetSignedCapability;
};

interface RemoteRead {
	readonly status: "ok" | "denied" | "uncertain";
	readonly code?: string;
	readonly revision?: number;
	readonly nextRevision?: number;
	readonly hasMore?: boolean;
	readonly events?: readonly {
		readonly eventId: string;
		readonly event: FoldEvent;
	}[];
}
interface RivetJournalHandle {
	acquire(
		input: AuthorizedInput<{
			holderId: string;
			requestId: string;
		}>,
	): Promise<RemoteDecision>;
	check(input: AuthorizedInput<LeaseInput>): Promise<RemoteDecision>;
	release(input: AuthorizedInput<LeaseInput>): Promise<RemoteDecision>;
	append(input: AuthorizedInput<AppendInput>): Promise<RemoteDecision>;
	read(input: AuthorizedInput<ReadInput>): Promise<RemoteRead>;
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
		if (
			typeof input !== "object" ||
			input === null ||
			utilTypes.isProxy(input) ||
			Array.isArray(input)
		)
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		Object.setPrototypeOf(properties, null);
		const value = (key: string): unknown => {
			const property = properties[key];
			if (property === undefined || !Object.hasOwn(property, "value"))
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
	request: ReadInput,
):
	| {
			revision: number;
			nextRevision: number;
			hasMore: boolean;
			events: { eventId: string; event: FoldEvent }[];
	  }
	| undefined {
	try {
		if (
			typeof input !== "object" ||
			input === null ||
			utilTypes.isProxy(input) ||
			Array.isArray(input)
		)
			return undefined;
		const properties = Object.getOwnPropertyDescriptors(input);
		Object.setPrototypeOf(properties, null);
		const status = properties.status;
		const revision = properties.revision;
		const nextRevision = properties.nextRevision;
		const hasMore = properties.hasMore;
		const events = properties.events;
		if (
			status === undefined ||
			!Object.hasOwn(status, "value") ||
			status.value !== "ok" ||
			revision === undefined ||
			!Object.hasOwn(revision, "value") ||
			typeof revision.value !== "number" ||
			!Number.isSafeInteger(revision.value) ||
			revision.value < 0 ||
			(request.throughRevision !== undefined &&
				revision.value !== request.throughRevision) ||
			revision.value < request.afterRevision ||
			nextRevision === undefined ||
			!Object.hasOwn(nextRevision, "value") ||
			typeof nextRevision.value !== "number" ||
			!Number.isSafeInteger(nextRevision.value) ||
			hasMore === undefined ||
			!Object.hasOwn(hasMore, "value") ||
			typeof hasMore.value !== "boolean" ||
			events === undefined ||
			!Object.hasOwn(events, "value") ||
			utilTypes.isProxy(events.value) ||
			!Array.isArray(events.value) ||
			events.value.length > request.limit ||
			nextRevision.value !== request.afterRevision + events.value.length ||
			nextRevision.value > revision.value ||
			hasMore.value !== nextRevision.value < revision.value ||
			(hasMore.value && events.value.length === 0)
		)
			return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(events.value);
		Object.setPrototypeOf(descriptors, null);
		const result: { eventId: string; event: FoldEvent }[] = [];
		let bytes = 0;
		const ids = new Set<string>();
		for (let index = 0; index < events.value.length; index++) {
			const item = descriptors[String(index)];
			if (
				item === undefined ||
				!Object.hasOwn(item, "value") ||
				typeof item.value !== "object" ||
				item.value === null ||
				utilTypes.isProxy(item.value) ||
				Array.isArray(item.value)
			)
				return undefined;
			const fields = Object.getOwnPropertyDescriptors(item.value);
			Object.setPrototypeOf(fields, null);
			const eventId = fields.eventId;
			const event = fields.event;
			if (
				eventId === undefined ||
				!Object.hasOwn(eventId, "value") ||
				typeof eventId.value !== "string" ||
				!validName(eventId.value) ||
				ids.has(eventId.value) ||
				event === undefined ||
				!Object.hasOwn(event, "value")
			)
				return undefined;
			const encoded = encodeDistributedEvent(event.value);
			if (encoded === undefined) return undefined;
			bytes += Buffer.byteLength(encoded);
			if (bytes > 524_288) return undefined;
			result.push({
				eventId: eventId.value,
				event: JSON.parse(encoded) as FoldEvent,
			});
			ids.add(eventId.value);
		}
		return {
			revision: revision.value,
			nextRevision: nextRevision.value,
			hasMore: hasMore.value,
			events: result,
		};
	} catch {
		return undefined;
	}
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof */

export function createRivetDistributedJournal(
	namespace: RivetJournalNamespace,
	scope: {
		tenantId: string;
		campId: string;
		issueCapability: (
			input: RivetOperation,
		) => RivetSignedCapability | Promise<RivetSignedCapability>;
	},
) {
	if (
		!validName(scope.tenantId) ||
		!validName(scope.campId) ||
		!(scope.issueCapability instanceof Function)
	)
		throw new TypeError("invalid Rivet journal scope");
	const tenantId = scope.tenantId;
	const campId = scope.campId;
	const issueCapability = scope.issueCapability;
	const capabilities = new WeakMap<AsyncActorLease, LeaseInput>();
	const handle = (key: string) => {
		if (!validName(key)) throw new TypeError("invalid Rivet actor key");
		return namespace.getOrCreate(["hobo", tenantId, campId, key]);
	};
	const authorize = async <T>(
		key: string,
		action: RivetJournalAction,
		input: T,
	): Promise<AuthorizedInput<T>> => {
		const args = snapshotDistributedData(input);
		if (args === undefined)
			throw new TypeError("invalid Rivet journal operation");
		const operation = {
			actorKey: ["hobo", tenantId, campId, key],
			action,
			args,
		};
		try {
			const digest = computeRivetOperationDigest(operation);
			const capability = await issueCapability(operation);
			if (digest !== computeRivetOperationDigest(operation))
				throw new Error("operation changed during authorization");
			return { args, capability };
		} catch {
			throw new RivetDistributedJournalError(
				"AUTHORIZATION_UNAVAILABLE",
				action,
			);
		}
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
		const { holderId, requestId } = input;
		if (!validName(holderId) || !validName(requestId))
			throw new TypeError("invalid Rivet lease request");
		const remote = handle(key);
		const stableInput = Object.freeze({ holderId, requestId });
		const proof = await authorize(key, "acquire", stableInput);
		const granted = await request("acquire", requestId, () =>
			remote.acquire(proof),
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
				requestId,
			);
		const capability = Object.freeze({
			holderId,
			requestId,
			fenceToken: granted.fenceToken,
		});
		const lease: AsyncActorLease = Object.freeze({
			key,
			holderId,
			fenceToken: BigInt(granted.fenceToken),
			expiresAt: new Date(granted.expiresAtMs).toISOString(),
			async revalidate() {
				const proof = await authorize(key, "check", capability);
				const response = await request("check", requestId, () =>
					remote.check(proof),
				);
				if (response.status !== "valid")
					throw new RivetDistributedJournalError(
						"INVALID_RECEIPT",
						"check",
						requestId,
					);
			},
			async release() {
				const proof = await authorize(key, "release", capability);
				const response = await request("release", requestId, () =>
					remote.release(proof),
				);
				if (response.status !== "released")
					throw new RivetDistributedJournalError(
						"OUTCOME_UNKNOWN",
						"release",
						requestId,
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
			const { eventId, expectedRevision, event } = input;
			if (
				!validName(eventId) ||
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 0
			)
				throw new TypeError("invalid Rivet journal event identity or revision");
			const encoded = encodeDistributedEvent(event);
			if (encoded === undefined)
				throw new TypeError("invalid Rivet journal event");
			const snapshot = JSON.parse(encoded) as FoldEvent;
			const remote = handle(key);
			const proof = await authorize(key, "append", {
				...capability,
				eventId,
				expectedRevision,
				event: snapshot,
			});
			const response = await request("append", capability.requestId, () =>
				remote.append(proof),
			);
			if (
				response.status !== "appended" ||
				!Number.isSafeInteger(response.revision) ||
				expectedRevision >= Number.MAX_SAFE_INTEGER ||
				response.revision !== expectedRevision + 1
			)
				throw new RivetDistributedJournalError(
					"OUTCOME_UNKNOWN",
					"append",
					capability.requestId,
				);
			return response;
		},
		async read(
			key: string,
			options: {
				afterRevision?: number;
				throughRevision?: number;
				limit?: number;
			} = {},
		) {
			const afterRevision = options.afterRevision ?? 0;
			const limit = options.limit ?? 16;
			const throughRevision = options.throughRevision;
			if (
				!Number.isSafeInteger(afterRevision) ||
				afterRevision < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 16 ||
				(throughRevision !== undefined &&
					(!Number.isSafeInteger(throughRevision) ||
						throughRevision < afterRevision))
			)
				throw new TypeError("invalid Rivet journal page");
			const page: ReadInput =
				throughRevision === undefined
					? { afterRevision, limit }
					: { afterRevision, limit, throughRevision };
			const proof = await authorize(key, "read", page);
			let raw: unknown;
			try {
				raw = await handle(key).read(proof);
			} catch {
				throw new RivetDistributedJournalError("UNAVAILABLE", "read");
			}
			const result = readSnapshot(raw, page);
			if (result === undefined) {
				const failure = readDecision(raw);
				if (failure?.status === "denied")
					throw new RivetDistributedJournalError(failure.code, "read");
				throw new RivetDistributedJournalError("UNAVAILABLE", "read");
			}
			return result;
		},
	};
}
