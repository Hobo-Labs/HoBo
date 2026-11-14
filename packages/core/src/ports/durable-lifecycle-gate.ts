/** Shared, non-expiring admission gate for supervised application lifecycle. */
import { createHash, randomUUID } from "node:crypto";
import type { PrincipalRef } from "../envelope.js";
import { isJsonObject, isJsonString, type JsonObject } from "../json.js";
import type { AsyncActorLease, AsyncActorLeaseHost } from "./actor-host.js";
import type { DurableEventStore } from "./eventstore.js";

export type LifecycleParticipantKind = "ingress" | "producer" | "worker";
export type DurableLifecyclePhase =
	| "uninitialized"
	| "open"
	| "draining"
	| "sealed"
	| "stopped";
export interface DurableLifecycleGateScope {
	readonly tenantId: string;
	readonly app: "ci" | "cd";
	/** Stable logical service identity shared by all overlapping deployments. */
	readonly serviceId: string;
	/** An independently approved immutable storage/incarnation identity. */
	readonly incarnationId: string;
}
export interface DurableLifecycleGateStatus {
	readonly scopeDigest: string;
	readonly phase: DurableLifecyclePhase;
	readonly fenceId?: string;
	readonly participants: readonly Readonly<{
		id: string;
		kind: LifecycleParticipantKind;
	}>[];
}
export interface DurableLifecycleGateOptions {
	readonly scope: DurableLifecycleGateScope;
	readonly store: DurableEventStore;
	readonly actorHost: AsyncActorLeaseHost;
	readonly actor: PrincipalRef;
	readonly nowMs: () => number;
	/** Authenticates the exact supervisor operation and its live Broker hold. */
	readonly authorize: (input: {
		readonly scope: DurableLifecycleGateScope;
		readonly scopeDigest: string;
		readonly action:
			| "initialize"
			| "drain"
			| "seal"
			| "resume-drain"
			| "stop"
			| "open"
			| "retire-participant";
		readonly operationId: string;
		readonly fenceId?: string;
	}) => Promise<void>;
	/** A fresh independent provider read of every queue partition and Sandbox.
	 * A zero participant count alone is never evidence of an empty queue. */
	readonly verifyDrained: (input: {
		readonly scope: DurableLifecycleGateScope;
		readonly scopeDigest: string;
		readonly fenceId: string;
		readonly operationId: string;
	}) => Promise<{
		readonly scopeDigest: string;
		readonly fenceId: string;
		readonly queuesDrained: true;
		readonly sandboxesDrained: true;
		readonly evidenceRef: string;
		readonly observedAtMs: number;
		readonly expiresAtMs: number;
	}>;
	/** Proves a crashed participant and all its effects are terminated. */
	readonly verifyParticipantTerminated: (input: {
		readonly scope: DurableLifecycleGateScope;
		readonly scopeDigest: string;
		readonly participantId: string;
		readonly kind: LifecycleParticipantKind;
		readonly evidenceRef: string;
	}) => Promise<void>;
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}(?![\s\S])/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?![\s\S])/u;
function fail(): never {
	throw new Error(
		"durable lifecycle gate is unavailable or its scope is invalid",
	);
}
function freezeScope(
	value: DurableLifecycleGateScope,
): DurableLifecycleGateScope {
	if (
		!NAME.test(value.tenantId) ||
		!NAME.test(value.serviceId) ||
		!NAME.test(value.incarnationId) ||
		!["ci", "cd"].includes(value.app)
	)
		fail();
	return Object.freeze({
		tenantId: value.tenantId,
		app: value.app,
		serviceId: value.serviceId,
		incarnationId: value.incarnationId,
	});
}

export type DurableLifecycleGate = ReturnType<
	typeof createDurableLifecycleGate
>;

/** The store must enforce the exact actor fence on `hosting-lifecycle-gate:`.
 * Every request registers before work; stopping is linearized against those
 * registrations and a crashed participant is never removed on time alone. */
export function createDurableLifecycleGate(
	options: DurableLifecycleGateOptions,
) {
	const scope = freezeScope(options.scope);
	const scopeDigest = `sha256:${createHash("sha256")
		.update(
			JSON.stringify([
				scope.tenantId,
				scope.app,
				scope.serviceId,
				scope.incarnationId,
			]),
		)
		.digest("hex")}`;
	const streamId = `hosting-lifecycle-gate:${scopeDigest}`;
	type State = {
		phase: DurableLifecyclePhase;
		fenceId?: string;
		participants: Map<string, LifecycleParticipantKind>;
		seq: number;
	};
	function snapshotValue(state: State) {
		const value = {
			scopeDigest,
			phase: state.phase,
			participants: [...state.participants]
				.map(([id, kind]) => ({ id, kind }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		};
		return state.fenceId ? { ...value, fenceId: state.fenceId } : value;
	}
	function stateDigest(state: ReturnType<typeof snapshotValue>) {
		return `sha256:${createHash("sha256").update(JSON.stringify(state)).digest("hex")}`;
	}
	async function read(): Promise<State> {
		const state: State = {
			phase: "uninitialized",
			participants: new Map(),
			seq: 0,
		};
		const snapshot = await options.store.loadSnapshot?.(streamId);
		if (snapshot) {
			const value: unknown = snapshot.state;
			if (
				snapshot.streamId !== streamId ||
				!Number.isSafeInteger(snapshot.seq) ||
				snapshot.seq < 1 ||
				!isJsonObject(value) ||
				value.scopeDigest !== scopeDigest ||
				!isJsonString(value.phase) ||
				!["open", "draining", "sealed", "stopped"].includes(value.phase) ||
				!Array.isArray(value.participants) ||
				(value.phase === "open") !== (value.fenceId === undefined) ||
				(value.fenceId !== undefined &&
					(!isJsonString(value.fenceId) || !NAME.test(value.fenceId)))
			)
				fail();
			// SAFETY: the validated phase is one of the durable lifecycle phases.
			state.phase = value.phase as DurableLifecyclePhase;
			if (isJsonString(value.fenceId)) state.fenceId = value.fenceId;
			for (const entry of value.participants) {
				if (
					!isJsonObject(entry) ||
					!isJsonString(entry.id) ||
					!NAME.test(entry.id) ||
					(entry.kind !== "ingress" &&
						entry.kind !== "producer" &&
						entry.kind !== "worker") ||
					state.participants.has(entry.id)
				)
					fail();
				state.participants.set(entry.id, entry.kind);
			}
			if (
				(state.phase === "sealed" || state.phase === "stopped") &&
				state.participants.size
			)
				fail();
			const expected = stateDigest(snapshotValue(state));
			let verified = false;
			for await (const row of options.store.read(streamId, snapshot.seq)) {
				verified =
					row.seq === snapshot.seq &&
					row.streamId === streamId &&
					row.tenant === scope.tenantId &&
					row.type === "lifecycle.Checkpoint" &&
					isJsonObject(row.data) &&
					row.data.scopeDigest === scopeDigest &&
					row.data.stateDigest === expected;
				break;
			}
			if (!verified) fail();
			state.seq = snapshot.seq;
		}
		for await (const row of options.store.read(streamId, state.seq + 1)) {
			if (
				row.tenant !== scope.tenantId ||
				row.streamId !== streamId ||
				row.seq !== state.seq + 1 ||
				!isJsonObject(row.data) ||
				row.data.scopeDigest !== scopeDigest
			)
				fail();
			const data = row.data;
			switch (row.type) {
				case "lifecycle.Initialized":
					if (state.phase !== "uninitialized") fail();
					state.phase = "open";
					break;
				case "lifecycle.ParticipantStarted":
					if (
						!isJsonString(data.id) ||
						!NAME.test(data.id) ||
						(data.kind !== "ingress" &&
							data.kind !== "producer" &&
							data.kind !== "worker") ||
						state.participants.has(data.id) ||
						!(
							state.phase === "open" ||
							(state.phase === "draining" && data.kind === "worker")
						)
					)
						fail();
					state.participants.set(data.id, data.kind);
					break;
				case "lifecycle.ParticipantFinished":
					if (!isJsonString(data.id) || !state.participants.delete(data.id))
						fail();
					break;
				case "lifecycle.Checkpoint":
					if (data.stateDigest !== stateDigest(snapshotValue(state))) fail();
					break;
				case "lifecycle.Draining":
					if (
						state.phase !== "open" ||
						!isJsonString(data.fenceId) ||
						!NAME.test(data.fenceId)
					)
						fail();
					state.phase = "draining";
					state.fenceId = data.fenceId;
					break;
				case "lifecycle.Sealed":
					if (
						state.phase !== "draining" ||
						state.participants.size ||
						data.fenceId !== state.fenceId
					)
						fail();
					state.phase = "sealed";
					break;
				case "lifecycle.DrainResumed":
					if (state.phase !== "sealed" || data.fenceId !== state.fenceId)
						fail();
					state.phase = "draining";
					break;
				case "lifecycle.Stopped":
					if (
						state.phase !== "sealed" ||
						state.participants.size ||
						data.fenceId !== state.fenceId ||
						!isJsonString(data.evidenceRef) ||
						!REF.test(data.evidenceRef)
					)
						fail();
					state.phase = "stopped";
					break;
				case "lifecycle.Opened":
					if (state.phase !== "stopped" || data.fenceId !== state.fenceId)
						fail();
					state.phase = "open";
					delete state.fenceId;
					break;
				default:
					fail();
			}
			state.seq = row.seq;
		}
		return state;
	}
	async function lock<T>(
		work: (state: State, lease: AsyncActorLease) => Promise<T>,
	): Promise<T> {
		let lease: AsyncActorLease | undefined;
		for (let i = 0; i < 80 && !lease; i++) {
			try {
				lease = await options.actorHost.acquire(streamId, {
					holderId: `lifecycle-${randomUUID()}`,
				});
			} catch {
				if (i === 79) fail();
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		if (!lease || lease.key !== streamId || lease.fenceToken < 1n) fail();
		try {
			await lease.revalidate();
			return await work(await read(), lease);
		} finally {
			await lease.release();
		}
	}
	async function append(
		state: State,
		lease: AsyncActorLease,
		type: string,
		data: JsonObject = {},
		beforeCommit?: () => Promise<void> | void,
	) {
		await lease.revalidate();
		await beforeCommit?.();
		await lease.revalidate();
		await options.store.commit({
			streamId,
			append: {
				tenant: scope.tenantId,
				actor: options.actor,
				expectedSeq: state.seq,
				fenceToken: lease.fenceToken,
			},
			events: [{ type, data: { scopeDigest, ...data } }],
		});
		// Snapshots are only hints: the authoritative, actor-fenced checkpoint
		// pins their complete state hash. An overwritten snapshot fails closed.
		if (options.store.loadSnapshot && (state.seq + 1) % 128 === 0) {
			try {
				const current = await read();
				if (current.seq !== state.seq + 1) fail();
				const value = snapshotValue(current);
				await lease.revalidate();
				await options.store.commit({
					streamId,
					append: {
						tenant: scope.tenantId,
						actor: options.actor,
						expectedSeq: current.seq,
						fenceToken: lease.fenceToken,
					},
					events: [
						{
							type: "lifecycle.Checkpoint",
							data: { scopeDigest, stateDigest: stateDigest(value) },
						},
					],
				});
				await lease.revalidate();
				await options.store.snapshot(streamId, value, current.seq + 1);
			} catch {
				// The operation is already committed. A later request replays the
				// old snapshot and can retry the checkpoint without losing work.
			}
		}
	}
	async function authorize(
		action: Parameters<DurableLifecycleGateOptions["authorize"]>[0]["action"],
		operationId: string,
		fenceId?: string,
	) {
		if (
			!NAME.test(operationId) ||
			(fenceId !== undefined && !NAME.test(fenceId))
		)
			fail();
		const input = { scope, scopeDigest, action, operationId };
		await options.authorize(fenceId ? { ...input, fenceId } : input);
	}
	return Object.freeze({
		scope,
		scopeDigest,
		streamId,
		async status(): Promise<DurableLifecycleGateStatus> {
			const state = await read();
			const result = {
				scopeDigest,
				phase: state.phase,
				participants: [...state.participants].map(([id, kind]) => ({
					id,
					kind,
				})),
			};
			return state.fenceId ? { ...result, fenceId: state.fenceId } : result;
		},
		async initialize(operationId: string) {
			return lock(async (state, lease) => {
				if (state.phase !== "uninitialized") return;
				await authorize("initialize", operationId);
				await append(state, lease, "lifecycle.Initialized", {}, () =>
					authorize("initialize", operationId),
				);
			});
		},
		async begin(
			kind: LifecycleParticipantKind,
		): Promise<{ readonly id: string; finish(): Promise<void> }> {
			if (kind !== "ingress" && kind !== "producer" && kind !== "worker")
				fail();
			const id = `participant:${randomUUID()}`;
			await lock(async (state, lease) => {
				if (
					!(
						state.phase === "open" ||
						(state.phase === "draining" && kind === "worker")
					)
				)
					fail();
				await append(state, lease, "lifecycle.ParticipantStarted", {
					id,
					kind,
				});
			});
			return Object.freeze({
				id,
				async finish() {
					await lock(async (state, lease) => {
						if (!state.participants.has(id)) return;
						if (state.participants.get(id) !== kind) fail();
						await append(state, lease, "lifecycle.ParticipantFinished", { id });
					});
				},
			});
		},
		async drain(operationId: string) {
			return lock(async (state, lease) => {
				if (state.phase !== "open") {
					if (!state.fenceId) fail();
					await authorize("drain", operationId, state.fenceId);
					return state.fenceId;
				}
				const fenceId = `fence-${randomUUID()}`;
				await authorize("drain", operationId, fenceId);
				await append(state, lease, "lifecycle.Draining", { fenceId }, () =>
					authorize("drain", operationId, fenceId),
				);
				return fenceId;
			});
		},
		async seal(
			operationId: string,
			fenceId: string,
		): Promise<"sealed" | "waiting"> {
			return lock(async (state, lease) => {
				if (state.fenceId !== fenceId) fail();
				if (state.phase === "sealed" || state.phase === "stopped")
					return "sealed";
				if (state.phase !== "draining") fail();
				if (state.participants.size) return "waiting";
				await authorize("seal", operationId, fenceId);
				await append(state, lease, "lifecycle.Sealed", { fenceId }, () =>
					authorize("seal", operationId, fenceId),
				);
				return "sealed";
			});
		},
		async resumeDrain(operationId: string, fenceId: string) {
			return lock(async (state, lease) => {
				if (state.phase !== "sealed" || state.fenceId !== fenceId) fail();
				await authorize("resume-drain", operationId, fenceId);
				await append(state, lease, "lifecycle.DrainResumed", { fenceId }, () =>
					authorize("resume-drain", operationId, fenceId),
				);
			});
		},
		async stop(operationId: string, fenceId: string) {
			return lock(async (state, lease) => {
				if (
					state.fenceId !== fenceId ||
					(state.phase !== "sealed" && state.phase !== "stopped")
				)
					fail();
				await authorize("stop", operationId, fenceId);
				const proof = await options.verifyDrained({
					scope,
					scopeDigest,
					fenceId,
					operationId,
				});
				const assertFreshProof = () => {
					const now = options.nowMs();
					if (
						proof.scopeDigest !== scopeDigest ||
						proof.fenceId !== fenceId ||
						proof.queuesDrained !== true ||
						proof.sandboxesDrained !== true ||
						!REF.test(proof.evidenceRef) ||
						!Number.isSafeInteger(now) ||
						!Number.isSafeInteger(proof.observedAtMs) ||
						!Number.isSafeInteger(proof.expiresAtMs) ||
						proof.observedAtMs > now ||
						now - proof.observedAtMs > 60_000 ||
						proof.expiresAtMs <= now ||
						proof.expiresAtMs > proof.observedAtMs + 300_000
					)
						fail();
				};
				assertFreshProof();
				await authorize("stop", operationId, fenceId);
				if (state.phase !== "stopped")
					await append(
						state,
						lease,
						"lifecycle.Stopped",
						{
							fenceId,
							evidenceRef: proof.evidenceRef,
						},
						async () => {
							await authorize("stop", operationId, fenceId);
							assertFreshProof();
						},
					);
				else assertFreshProof();
				return proof;
			});
		},
		async open(operationId: string, fenceId: string) {
			return lock(async (state, lease) => {
				if (state.phase !== "stopped" || state.fenceId !== fenceId) fail();
				await authorize("open", operationId, fenceId);
				await append(state, lease, "lifecycle.Opened", { fenceId }, () =>
					authorize("open", operationId, fenceId),
				);
			});
		},
		async retireParticipant(
			operationId: string,
			participantId: string,
			evidenceRef: string,
		) {
			return lock(async (state, lease) => {
				const kind = state.participants.get(participantId);
				if (!kind || !REF.test(evidenceRef)) fail();
				await authorize("retire-participant", operationId, state.fenceId);
				await options.verifyParticipantTerminated({
					scope,
					scopeDigest,
					participantId,
					kind,
					evidenceRef,
				});
				await authorize("retire-participant", operationId, state.fenceId);
				await append(
					state,
					lease,
					"lifecycle.ParticipantFinished",
					{
						id: participantId,
					},
					() => authorize("retire-participant", operationId, state.fenceId),
				);
			});
		},
	});
}
