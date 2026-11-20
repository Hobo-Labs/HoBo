import { createHash, randomUUID } from "node:crypto";
import {
	type EventInput,
	type EventStore,
	isEventStoreOptimisticConflict,
} from "@hobo/core";
import { z } from "zod";
import type { ReleaseProvider } from "./release-controller.js";

export type ReleaseTarget = Readonly<{
	provider: string;
	project: string;
}>;

export type ReleaseEffect<T> =
	| Readonly<{ state: "settled"; value: T }>
	| Readonly<{ state: "pending" }>;

export type ReleaseReservation = Readonly<{
	run<T>(effect: () => Promise<ReleaseEffect<T>>): Promise<ReleaseEffect<T>>;
	finish(outcome: "verified" | "rolled-back" | "cancelled"): Promise<void>;
}>;

export type ReleaseReservationResult =
	| Readonly<{ acquired: false; commit: string }>
	| Readonly<{ acquired: true; reservation: ReleaseReservation }>;

export type ReleaseReservationAuthority = Readonly<{
	acquire(
		target: ReleaseTarget,
		commit: string,
	): Promise<ReleaseReservationResult>;
}>;

export function createReservedReleaseProvider(
	provider: ReleaseProvider,
	reservation: ReleaseReservation,
): ReleaseProvider {
	const run = async (effect: () => Promise<"settled" | "pending">) => {
		const result = await reservation.run(async () => {
			const state = await effect();
			return state === "settled" ? { state, value: undefined } : { state };
		});
		return result.state;
	};
	return {
		inspect: (id) => provider.inspect(id),
		canRollback: (id) => provider.canRollback(id),
		current: () => provider.current(),
		promote: (id) => run(() => provider.promote(id)),
		rollback: (id) => run(() => provider.rollback(id)),
		probe: (commit) => provider.probe(commit),
	};
}

const attempt = z.string().uuid();
const reservedData = z
	.object({ attempt, commit: z.string().regex(/^[0-9a-f]{40}$/u) })
	.strict();
const effectData = z.object({ attempt, operation: z.string().uuid() }).strict();
const completedData = z
	.object({
		attempt,
		outcome: z.enum(["verified", "rolled-back", "cancelled"]),
	})
	.strict();
type Active = z.infer<typeof reservedData> & { pending?: string };

export function createReleaseReservationAuthority(
	store: Pick<EventStore, "read" | "append">,
): ReleaseReservationAuthority {
	async function read(
		streamId: string,
	): Promise<{ seq: number; active?: Active }> {
		let seq = 0;
		let active: Active | undefined;
		for await (const event of store.read(streamId)) {
			if (event.streamId !== streamId || event.seq !== seq + 1 || event.v !== 1)
				throw new Error("Invalid release reservation history.");
			seq = event.seq;
			if (event.type === "release.Reserved") {
				const parsed = reservedData.safeParse(event.data);
				if (!parsed.success || active)
					throw new Error("Invalid release reservation history.");
				active = parsed.data;
			} else if (event.type === "release.EffectStarted") {
				const parsed = effectData.safeParse(event.data);
				if (
					!parsed.success ||
					!active ||
					active.pending ||
					active.attempt !== parsed.data.attempt
				)
					throw new Error("Invalid release reservation history.");
				active = { ...active, pending: parsed.data.operation };
			} else if (event.type === "release.EffectSettled") {
				const parsed = effectData.safeParse(event.data);
				if (
					!parsed.success ||
					!active ||
					active.attempt !== parsed.data.attempt ||
					active.pending !== parsed.data.operation
				)
					throw new Error("Invalid release reservation history.");
				active = { attempt: active.attempt, commit: active.commit };
			} else if (event.type === "release.Completed") {
				const parsed = completedData.safeParse(event.data);
				if (
					!parsed.success ||
					!active ||
					active.pending ||
					active.attempt !== parsed.data.attempt
				)
					throw new Error("Invalid release reservation history.");
				active = undefined;
			} else {
				throw new Error("Invalid release reservation history.");
			}
		}
		if (active) return { seq, active };
		return { seq };
	}

	async function append(streamId: string, seq: number, event: EventInput) {
		const result = await store.append(streamId, [event], {
			expectedSeq: seq,
			actor: { kind: "system", id: "hobo-cd-release" },
			tenant: "hobo-cd",
		});
		if (
			result.streamId !== streamId ||
			result.appended.length !== 1 ||
			result.deduped.length !== 0 ||
			result.appended[0]?.seq !== seq + 1 ||
			result.appended[0]?.type !== event.type
		)
			throw new Error("Release reservation was not confirmed.");
	}

	async function acquire(
		target: ReleaseTarget,
		commit: string,
	): Promise<ReleaseReservationResult> {
		if (
			![target.provider, target.project].every(
				(value) => value.length > 0 && value.length <= 4096,
			) ||
			!/^[0-9a-f]{40}$/u.test(commit)
		)
			throw new TypeError("Invalid release reservation request.");
		const digest = createHash("sha256")
			.update(JSON.stringify([target.provider, target.project]))
			.digest("hex");
		const streamId = `hobo-release-${digest}`;
		const id = randomUUID();
		for (let retry = 0; retry < 16; retry++) {
			const head = await read(streamId);
			if (head.active) return { acquired: false, commit: head.active.commit };
			try {
				await append(streamId, head.seq, {
					type: "release.Reserved",
					data: { attempt: id, commit },
				});
			} catch (error) {
				if (error instanceof Error && isEventStoreOptimisticConflict(error))
					continue;
				throw new Error("Release reservation could not be confirmed.");
			}
			let unusable = false;
			const ownHead = async () => {
				if (unusable)
					throw new Error("Release reservation is no longer usable.");
				const current = await read(streamId);
				if (
					!current.active ||
					current.active.attempt !== id ||
					current.active.pending
				)
					throw new Error(
						"Release reservation is not available for an effect.",
					);
				return current;
			};
			return {
				acquired: true,
				reservation: {
					async run(effect) {
						const operation = randomUUID();
						try {
							const current = await ownHead();
							await append(streamId, current.seq, {
								type: "release.EffectStarted",
								data: { attempt: id, operation },
							});
							const result = await effect();
							if (result.state !== "settled") {
								unusable = true;
								return { state: "pending" };
							}
							await append(streamId, current.seq + 1, {
								type: "release.EffectSettled",
								data: { attempt: id, operation },
							});
							return result;
						} catch {
							unusable = true;
							throw new Error("Release effect could not be confirmed.");
						}
					},
					async finish(outcome) {
						const current = await ownHead();
						unusable = true;
						try {
							await append(streamId, current.seq, {
								type: "release.Completed",
								data: { attempt: id, outcome },
							});
						} catch {
							throw new Error("Release completion could not be confirmed.");
						}
					},
				},
			};
		}
		throw new Error("Release reservation is contended.");
	}
	return { acquire };
}
