import { createHash } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type PrincipalRef,
	type ResourceMutationJournal,
	type ResourceMutationJournalEntry,
	ResourceMutationJournalEntrySchema,
} from "@hobo/core";

/** Durable single-attempt claim before an external mutation. Only the process
 * that commits a fresh claim may send. A crash/lost acknowledgement is uncertain,
 * including a crash between the claim and the network call. */
export function createDurableHostingMutationJournal(options: {
	readonly store: DurableEventStore;
	readonly tenantId: string;
	readonly actor: PrincipalRef;
	readonly fenceToken: bigint;
	readonly nowMs?: () => number;
}): ResourceMutationJournal {
	if (!options.tenantId || options.fenceToken < 1n)
		throw new Error(
			"hosting mutation journal requires tenant and positive owner fence",
		);
	const at = options.nowMs ?? Date.now;
	function stream(mutationId: string) {
		if (!mutationId || mutationId.length > 2048)
			throw new Error("bounded stable mutation identity required");
		const digest = createHash("sha256").update(mutationId).digest("hex");
		return `hosting-mutation:${encodeURIComponent(options.tenantId)}:${digest}`;
	}
	function digest(value: string) {
		if (!/^sha256:[a-f0-9]{64}$/.test(value))
			throw new Error("mutation requires a canonical content digest");
	}
	async function read(mutationId: string) {
		let entry: ResourceMutationJournalEntry | undefined;
		let seq = 0;
		const streamId = stream(mutationId);
		for await (const event of options.store.read(streamId)) {
			if (
				event.tenant !== options.tenantId ||
				event.streamId !== streamId ||
				event.seq !== seq + 1
			)
				throw new Error("foreign or inconsistent mutation journal");
			const parsed = fromJson(
				ResourceMutationJournalEntrySchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			if (
				parsed.mutationId !== mutationId ||
				!["claimed", "acknowledged", "uncertain"].includes(parsed.status)
			)
				throw new Error("invalid mutation journal record");
			digest(parsed.requestDigest);
			if (
				entry &&
				(entry.requestDigest !== parsed.requestDigest ||
					entry.status === "acknowledged")
			)
				throw new Error(
					"mutation journal changes immutable identity or terminal state",
				);
			entry = parsed;
			seq = event.seq;
		}
		return { entry, seq };
	}
	async function write(
		mutationId: string,
		requestDigest: string,
		status: string,
		seq: number,
	) {
		const recordedAtMs = at();
		if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0)
			throw new Error("invalid hosting mutation journal clock");
		const entry = create(ResourceMutationJournalEntrySchema, {
			mutationId,
			requestDigest,
			status,
			recordedAtMs,
		});
		await options.store.commit({
			streamId: stream(mutationId),
			append: {
				expectedSeq: seq,
				tenant: options.tenantId,
				actor: options.actor,
				fenceToken: options.fenceToken,
			},
			events: [
				{
					type:
						status === "claimed"
							? "hosting.MutationClaimed"
							: status === "acknowledged"
								? "hosting.MutationAcknowledged"
								: "hosting.MutationUncertain",
					data: toJson(ResourceMutationJournalEntrySchema, entry),
				},
			],
		});
	}
	function verify(entry: ResourceMutationJournalEntry, requestDigest: string) {
		if (entry.requestDigest !== requestDigest)
			throw new Error("mutation identity reused with a different request");
	}
	async function finish(
		mutationId: string,
		requestDigest: string,
		status: "acknowledged" | "uncertain",
	) {
		digest(requestDigest);
		const current = await read(mutationId);
		if (!current.entry) throw new Error("mutation has no durable claim");
		verify(current.entry, requestDigest);
		if (
			current.entry.status === status ||
			current.entry.status === "acknowledged"
		)
			return;
		await write(mutationId, requestDigest, status, current.seq);
	}
	return {
		persistence: "durable-cas",
		async claim({ mutationId, requestDigest }) {
			digest(requestDigest);
			const current = await read(mutationId);
			if (current.entry) {
				verify(current.entry, requestDigest);
				return {
					status:
						current.entry.status === "acknowledged"
							? "acknowledged"
							: "uncertain",
				};
			}
			try {
				await write(mutationId, requestDigest, "claimed", current.seq);
				return { status: "claimed" };
			} catch (error) {
				// A committed claim with a lost response must never become a second send.
				const observed = await read(mutationId);
				if (!observed.entry) throw error;
				verify(observed.entry, requestDigest);
				return {
					status:
						observed.entry.status === "acknowledged"
							? "acknowledged"
							: "uncertain",
				};
			}
		},
		acknowledge(mutationId, requestDigest) {
			return finish(mutationId, requestDigest, "acknowledged");
		},
		uncertain(mutationId, requestDigest) {
			return finish(mutationId, requestDigest, "uncertain");
		},
	};
}
