import type { DurableMessagingConformanceHarness } from "@hobo/conformance";
import { DURABLE_MESSAGING_LIMITS } from "@hobo/core";
import { expect, it, vi } from "vitest";
import { createRivetDurableTopicActor } from "../src/durable-topic-actor.js";
import {
	createRivetDurableTopicMetadataGrant,
	type RivetDurableTopicClientOptions,
} from "../src/durable-topic-client.js";
import {
	createRivetMessagingConformanceHarness,
	runRivetMessagingConformance,
} from "./fixtures/durable-topic-conformance.js";

const partial = {
	topicCreation: true,
	publish: true,
	readRetainedLog: true,
	compaction: true,
	auditEvents: true,
	consumerGroups: false,
	leases: false,
	acknowledgement: false,
	deadLetter: false,
	legacyWit: false,
};
const full = {
	...partial,
	consumerGroups: true,
	leases: true,
	acknowledgement: true,
	deadLetter: true,
};
function options(complete: boolean): RivetDurableTopicClientOptions {
	return {
		binding: {
			actorName: "hoboTopic",
			actorKey: ["tenant-a"],
			tenant: "tenant-a",
			instance: "test",
			semanticDigest: `sha256:${"a".repeat(64)}`,
			limits: {
				...DURABLE_MESSAGING_LIMITS,
				payloadBytes: 8192,
				attributeBytes: 2048,
				batchSize: 4,
				retainedMessages: 128,
				retainedEvents: 128,
				topics: 32,
				subscriptions: 16,
			},
			actorCapabilities: complete ? full : partial,
		},
		metadataGrant: createRivetDurableTopicMetadataGrant(),
		verifyTransport: () => true,
		authorize: () => ({ "x-hobo-proof": "test" }),
		revalidate: () => true,
		fetch: async () => {
			throw new Error("not dispatched");
		},
	};
}
function controls(): Omit<DurableMessagingConformanceHarness, "connect"> {
	const unavailable = async () => {
		throw new Error("fault control not independently verified");
	};
	return {
		restart: unavailable,
		close: vi.fn(async () => {}),
		nowMs: () => 1000,
		advanceMs: unavailable,
		loseNextMutationResponse: unavailable,
		loseNextMutationTransport: unavailable,
		rejectNextDeadLetterWrite: unavailable,
		blockNextReceiptLookup: unavailable,
		switchAuthority: unavailable,
		holdNextMutation: unavailable,
		holdConcurrentMutations: unavailable,
	};
}

it("does not run or claim full conformance for the partial actor", async () => {
	const authority = controls();
	const actor = createRivetDurableTopicActor({
		actorName: "hoboTopic",
		semanticDigest: `sha256:${"a".repeat(64)}`,
		now: () => 1000,
		resolveScope: () => ({ tenant: "tenant-a", instance: "test" }),
		authorize: () => true,
		verifyIngress: () => true,
	});
	const host = {
		open: vi.fn(async () => {
			const client = options(false);
			return {
				...client,
				binding: {
					...client.binding,
					limits: actor.limits,
					actorCapabilities: actor.capabilities,
				},
			};
		}),
		controls: authority,
	};
	const report = await runRivetMessagingConformance(async () => host, {
		case: "group-isolation",
	});
	expect(report.selection).toBe("group-isolation");
	expect(report.cases).toEqual([
		{
			name: "group-isolation",
			status: "unknown",
			detail: "harness creation failed; independent host fencing is required",
		},
	]);
	expect(
		Object.values(report.executionEvidence).every(
			(value) => value === "unverified",
		),
	).toBe(true);
	expect(authority.close).toHaveBeenCalledTimes(1);
});

it("delegates to host-controlled process and fault primitives for a full capability binding", async () => {
	const authority = controls();
	const open = vi.fn(async () => options(true));
	const harness = await createRivetMessagingConformanceHarness({
		open,
		controls: authority,
	});
	const client = await harness.connect("tenant-a");
	expect(client.limits.batchSize).toBe(4);
	expect(open).toHaveBeenCalledTimes(1);
	await expect(harness.loseNextMutationTransport("disconnect")).rejects.toThrow(
		"not independently verified",
	);
	await expect(harness.restart()).rejects.toThrow("not independently verified");
	await expect(harness.connect("tenant-a")).rejects.toThrow("not available");
	await harness.close();
	expect(authority.close).toHaveBeenCalledTimes(1);
});

it("blocks new connections during owner transition and discards the old cached client", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const authority = {
		...controls(),
		restart: vi.fn(async () => {
			await gate;
		}),
	};
	const open = vi.fn(async () => options(true));
	const harness = await createRivetMessagingConformanceHarness({
		open,
		controls: authority,
	});
	const restarting = harness.restart();
	await expect(harness.connect("tenant-a")).rejects.toThrow("not available");
	release();
	await restarting;
	await harness.connect("tenant-a");
	expect(open).toHaveBeenCalledTimes(2);
	await harness.close();
});

it("rejects a client opened after its host owner has restarted", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let opens = 0;
	const open = vi.fn(async () => {
		opens++;
		if (opens === 2) await gate;
		return options(true);
	});
	const authority = { ...controls(), restart: vi.fn(async () => {}) };
	const harness = await createRivetMessagingConformanceHarness({
		open,
		controls: authority,
	});
	const pending = harness.connect("tenant-b");
	await harness.restart();
	release();
	await expect(pending).rejects.toThrow("owner changed");
	await harness.close();
});
