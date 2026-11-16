import { createHash, randomUUID } from "node:crypto";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type PrincipalRef,
	type ResourceMutationJournalEntry,
	ResourceMutationJournalEntrySchema,
} from "@hobo/core";

export interface HostingMutationScope {
	readonly persistence: "durable-cas";
	run<T>(
		scope: { providerId: string; providerAccountId: string; parentId: string },
		action: () => Promise<T>,
	): Promise<T>;
}

/** Serializes read-modify-write of a native shared parent across deployments and
 * processes. An uncertain send keeps the scope occupied. No clock expiry can
 * prove a delayed native write has finished, so this lock never expires itself. */
export function createDurableHostingMutationScope(options: {
	readonly store: DurableEventStore;
	readonly tenantId: string;
	readonly actor: PrincipalRef;
	readonly fenceToken: bigint;
	readonly nowMs: () => number;
}): HostingMutationScope {
	if (!options.tenantId || options.fenceToken < 1n)
		throw new Error(
			"native mutation scope requires authenticated tenant and positive writer fence",
		);
	async function read(streamId: string, requestDigest: string) {
		let prior: ResourceMutationJournalEntry | undefined;
		let seq = 0;
		for await (const event of options.store.read(streamId)) {
			if (
				event.streamId !== streamId ||
				event.tenant !== options.tenantId ||
				event.seq !== seq + 1
			)
				throw new Error(
					"foreign or noncontiguous native mutation scope history",
				);
			const next = fromJson(
				ResourceMutationJournalEntrySchema,
				JSON.parse(JSON.stringify(event.data)),
			);
			if (
				!["claimed", "acknowledged", "uncertain"].includes(next.status) ||
				!next.mutationId ||
				next.requestDigest !== requestDigest ||
				(!prior && next.status !== "claimed")
			)
				throw new Error("invalid native mutation scope history");
			if (
				prior &&
				(prior.requestDigest !== next.requestDigest ||
					(prior.status !== "acknowledged" &&
						(next.mutationId !== prior.mutationId ||
							next.status === "claimed")) ||
					(prior.status === "acknowledged" && next.status !== "claimed"))
			)
				throw new Error("native mutation scope changes unresolved ownership");
			prior = next;
			seq = event.seq;
		}
		return { entry: prior, seq };
	}
	async function write(
		streamId: string,
		owner: string,
		digest: string,
		status: string,
		seq: number,
	) {
		const recordedAtMs = options.nowMs();
		if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0)
			throw new Error("invalid native mutation scope clock");
		await options.store.commit({
			streamId,
			append: {
				expectedSeq: seq,
				tenant: options.tenantId,
				actor: options.actor,
				fenceToken: options.fenceToken,
			},
			events: [
				{
					type: "hosting.NativeMutationScopeChanged",
					data: toJson(
						ResourceMutationJournalEntrySchema,
						create(ResourceMutationJournalEntrySchema, {
							mutationId: owner,
							requestDigest: digest,
							status,
							recordedAtMs,
						}),
					),
				},
			],
		});
	}
	return {
		persistence: "durable-cas",
		async run(scope, action) {
			if (
				!scope.providerId ||
				!scope.providerAccountId ||
				!scope.parentId ||
				scope.parentId.length > 2048
			)
				throw new Error(
					"native mutation scope requires exact provider, account and parent identity",
				);
			const identity = JSON.stringify([
				scope.providerId,
				scope.providerAccountId,
				scope.parentId,
			]);
			const digest = `sha256:${createHash("sha256").update(identity).digest("hex")}`;
			// Tenant is in the record's authorization, not the lock key: two tenants
			// cannot safely mutate the same provider account and native parent.
			const streamId = `hosting-native-scope:${digest}`;
			const current = await read(streamId, digest);
			if (current.entry && current.entry.status !== "acknowledged")
				throw new Error(
					"native shared parent has an in-flight or uncertain mutation; independent reconciliation is required",
				);
			const owner = randomUUID();
			await write(streamId, owner, digest, "claimed", current.seq);
			let value: Awaited<ReturnType<typeof action>>;
			try {
				value = await action();
			} catch (error) {
				await write(streamId, owner, digest, "uncertain", current.seq + 1);
				throw error;
			}
			try {
				await write(streamId, owner, digest, "acknowledged", current.seq + 1);
			} catch (error) {
				const observed = await read(streamId, digest);
				if (
					observed.entry?.mutationId !== owner ||
					observed.entry.status !== "acknowledged"
				)
					throw error;
			}
			return value;
		},
	};
}
