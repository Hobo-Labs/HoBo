import {
	DURABLE_MESSAGING_CONFORMANCE_CASES,
	runDurableMessagingConformance,
} from "@hobo/conformance";
import { durableMessagingOperation } from "@hobo/core";
import { expect, it } from "vitest";
import { createRivetDurableTopicClient } from "../src/durable-topic-client.js";
import {
	createRivetMessagingConformanceHarness,
	runRivetMessagingConformance,
} from "./fixtures/durable-topic-conformance.js";
import { createProcessBusConformanceHost } from "./fixtures/durable-topic-process-conformance.js";

it("runs generic bus cases across real SQLite actor process termination", {
	timeout: 180_000,
}, async () => {
	const supported = new Set([
		"group-isolation",
		"restart",
		"ack-before-commit-uncertainty",
		"ack-after-commit-uncertainty",
		"lease-expiry",
		"lease-receipt-replay",
		"dead-letter",
		"compaction",
		"transport-throw-after-commit",
		"transport-disconnect-after-commit",
		"receipt-revocation",
		"receipt-capacity",
		"receipt-unavailable",
		"revoked-receipt-privacy",
		"expiry-boundary",
		"pending-conflict",
		"failover",
		"operation-replay",
		"concurrent-operations",
		"concurrent-claims",
		"ack-expiry-race",
		"compact-publish-race",
		"compact-earliest-race",
		"compact-latest-race",
		"detached-requests",
		"fingerprint-fields",
		"tenant-isolation",
		"audit-pagination",
		"audit-retention",
		"topic-capacity",
		"bounds",
	]);
	const results = [];
	for (const name of DURABLE_MESSAGING_CONFORMANCE_CASES) {
		const report = await runRivetMessagingConformance(
			async () => {
				if (!supported.has(name))
					throw new Error("fixture control or profile unavailable");
				return createProcessBusConformanceHost();
			},
			{ case: name, caseTimeoutMs: 30_000 },
		);
		expect(
			Object.values(report.executionEvidence).every(
				(value) => value === "unverified",
			),
		).toBe(true);
		results.push(...report.cases);
	}
	console.log("Process bus generic conformance:", JSON.stringify(results));
	expect(results).toHaveLength(DURABLE_MESSAGING_CONFORMANCE_CASES.length);
	expect(results.filter((result) => result.status === "fail")).toEqual([]);
	expect(
		results
			.filter((result) => result.status === "pass")
			.map(({ name }) => name),
	).toEqual(
		DURABLE_MESSAGING_CONFORMANCE_CASES.filter((name) => supported.has(name)),
	);
	expect(results.filter((result) => result.status === "unknown")).toHaveLength(
		DURABLE_MESSAGING_CONFORMANCE_CASES.length - supported.size,
	);
});

it("reconciles a lost committed reply after terminating the old actor process", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	try {
		const old = createRivetDurableTopicClient(await host.open("tenant-a"));
		const request = {
			operation: durableMessagingOperation(10_000, "0000000000000001"),
			topic: "orders",
		};
		await host.controls.loseNextMutationResponse("after-commit");
		expect(await old.ensureTopic(request)).toEqual({
			status: "unknown",
			operation: request.operation,
		});
		await host.controls.restart();
		expect(() => old.limits).toThrow();
		expect(await old.ensureTopic(request)).toEqual({
			status: "unknown",
			operation: request.operation,
		});
		const current = createRivetDurableTopicClient(await host.open("tenant-a"));
		expect(await current.ensureTopic(request)).toEqual({
			status: "committed",
			value: { topic: "orders" },
		});
		expect(await current.events({ afterSequence: 0, limit: 2 })).toMatchObject({
			status: "ok",
			events: [{ sequence: 1, kind: "topic-created", topic: "orders" }],
		});
	} finally {
		await host.controls.close();
	}
});

it("fences and drains a held request during process-host teardown", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	const client = createRivetDurableTopicClient(await host.open("tenant-a"));
	const barrier = await host.controls.holdNextMutation("before-dispatch");
	const request = {
		operation: durableMessagingOperation(10_000, "0000000000000002"),
		topic: "orders",
	};
	const pending = client.ensureTopic(request);
	await barrier.reached;
	await host.controls.close();
	expect(await pending).toEqual({
		status: "unknown",
		operation: request.operation,
	});
	expect(() => client.limits).toThrow();
});

it("reaps a newly started worker when close races a restart", {
	timeout: 30_000,
}, async () => {
	let signalReady = (_pid: number) => {};
	const ready = new Promise<number>((resolve) => {
		signalReady = resolve;
	});
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const host = await createProcessBusConformanceHost({
		afterRestartReady: async (pid) => {
			signalReady(pid);
			await gate;
		},
	});
	try {
		const restarting = host.controls.restart().then(
			() => false,
			() => true,
		);
		const pid = await ready;
		let closed = false;
		const closing = host.controls.close().then(() => {
			closed = true;
		});
		await expect(host.open("tenant-a")).rejects.toThrow();
		await Promise.resolve();
		expect(closed).toBe(false);
		release();
		expect(await restarting).toBe(true);
		await closing;
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ESRCH"
			)
				throw error;
			alive = false;
		}
		expect(alive).toBe(false);
	} finally {
		release();
		await host.controls.close();
	}
});

it("fences both requests held at the paired dispatch barrier during teardown", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	try {
		const first = createRivetDurableTopicClient(await host.open("tenant-a"));
		const second = createRivetDurableTopicClient(await host.open("tenant-a"));
		const firstOperation = durableMessagingOperation(
			10_000,
			"0000000000000011",
		);
		const secondOperation = durableMessagingOperation(
			10_000,
			"0000000000000012",
		);
		const barrier = await host.controls.holdConcurrentMutations();
		const one = first.ensureTopic({ operation: firstOperation, topic: "one" });
		const two = second.ensureTopic({
			operation: secondOperation,
			topic: "two",
		});
		await barrier.reached;
		await host.controls.close();
		expect(await Promise.all([one, two])).toEqual([
			{ status: "unknown", operation: firstOperation },
			{ status: "unknown", operation: secondOperation },
		]);
	} finally {
		await host.controls.close();
	}
});

it("drains a held commit on restart and reconciles the old request", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	try {
		const old = createRivetDurableTopicClient(await host.open("tenant-a"));
		const operation = durableMessagingOperation(10_000, "0000000000000013");
		const barrier = await host.controls.holdNextMutation("before-commit");
		const pending = old.ensureTopic({ operation, topic: "restart-held" });
		await barrier.reached;
		await host.controls.restart();
		expect(await pending).toEqual({ status: "unknown", operation });
		const reopened = createRivetDurableTopicClient(await host.open("tenant-a"));
		expect(
			await reopened.ensureTopic({ operation, topic: "restart-held" }),
		).toEqual({
			status: "committed",
			value: { topic: "restart-held" },
		});
		expect(await reopened.events({ afterSequence: 0, limit: 2 })).toMatchObject(
			{
				status: "ok",
				events: [{ sequence: 1, kind: "topic-created", topic: "restart-held" }],
			},
		);
	} finally {
		await host.controls.close();
	}
});

it("fences disclosure when closing with a transaction held before commit", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	const client = createRivetDurableTopicClient(await host.open("tenant-a"));
	const operation = durableMessagingOperation(10_000, "0000000000000014");
	const barrier = await host.controls.holdNextMutation("before-commit");
	const pending = client.ensureTopic({ operation, topic: "close-held" });
	await barrier.reached;
	await host.controls.close();
	expect(await pending).toEqual({ status: "unknown", operation });
});

it("rolls back state and receipt when the worker fails before commit", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost();
	try {
		const first = createRivetDurableTopicClient(await host.open("tenant-a"));
		const operation = durableMessagingOperation(10_000, "0000000000000015");
		await host.controls.loseNextMutationResponse("before-commit");
		expect(
			await first.ensureTopic({ operation, topic: "rolled-back" }),
		).toEqual({
			status: "unknown",
			operation,
		});
		await host.controls.restart();
		const reopened = createRivetDurableTopicClient(await host.open("tenant-a"));
		expect(await reopened.events({ afterSequence: 0, limit: 2 })).toMatchObject(
			{
				status: "ok",
				events: [],
			},
		);
		expect(
			await reopened.ensureTopic({ operation, topic: "rolled-back" }),
		).toEqual({
			status: "committed",
			value: { topic: "rolled-back" },
		});
		expect(await reopened.events({ afterSequence: 0, limit: 2 })).toMatchObject(
			{
				status: "ok",
				events: [{ sequence: 1, kind: "topic-created", topic: "rolled-back" }],
			},
		);
	} finally {
		await host.controls.close();
	}
});

it("replaces unverified and verified owners with distinct processes on the same journal", {
	timeout: 30_000,
}, async () => {
	const pids: number[] = [];
	const host = await createProcessBusConformanceHost({
		afterRestartReady: async (pid) => {
			pids.push(pid);
		},
	});
	try {
		const original = createRivetDurableTopicClient(await host.open("tenant-a"));
		const operation = durableMessagingOperation(10_000, "0000000000000016");
		const request = { operation, topic: "failover" };
		expect(await original.ensureTopic(request)).toEqual({
			status: "committed",
			value: { topic: "failover" },
		});
		await host.controls.switchAuthority("unverified");
		const unverified = createRivetDurableTopicClient(
			await host.open("tenant-a"),
		);
		expect(await unverified.ensureTopic(request)).toEqual({
			status: "unknown",
			operation,
		});
		await host.controls.switchAuthority("verified-shared");
		const successor = createRivetDurableTopicClient(
			await host.open("tenant-a"),
		);
		expect(await successor.ensureTopic(request)).toEqual({
			status: "committed",
			value: { topic: "failover" },
		});
		expect(
			await successor.events({ afterSequence: 0, limit: 2 }),
		).toMatchObject({
			status: "ok",
			events: [{ sequence: 1, kind: "topic-created", topic: "failover" }],
		});
		expect(pids).toHaveLength(2);
		expect(pids[0]).not.toBe(pids[1]);
	} finally {
		await host.controls.close();
	}
});

it("fails closed when the replacement owner cannot become ready", {
	timeout: 30_000,
}, async () => {
	const host = await createProcessBusConformanceHost({
		afterRestartReady: async () => {
			throw new Error("injected owner failure");
		},
	});
	try {
		await expect(
			host.controls.switchAuthority("verified-shared"),
		).rejects.toThrow();
		await expect(host.open("tenant-a")).rejects.toThrow();
	} finally {
		await host.controls.close();
	}
});

it("detects altered retained audit events in the bounded compaction profile", {
	timeout: 60_000,
}, async () => {
	const report = await runDurableMessagingConformance(
		async () => {
			const harness = await createRivetMessagingConformanceHarness(
				await createProcessBusConformanceHost(),
			);
			return {
				...harness,
				async connect(tenant) {
					const client = await harness.connect(tenant);
					return {
						...client,
						async events(input) {
							const outcome = await client.events(input);
							if (
								outcome.status !== "ok" ||
								input.afterSequence === 0 ||
								outcome.events.length === 0
							)
								return outcome;
							return {
								...outcome,
								events: outcome.events.map((event, index) =>
									index === 0
										? {
												...event,
												kind:
													event.kind === "published"
														? ("compacted" as const)
														: ("published" as const),
											}
										: event,
								),
							};
						},
					};
				},
			};
		},
		{ case: "audit-retention", caseTimeoutMs: 30_000 },
	);
	expect(report.cases).toMatchObject([
		{ name: "audit-retention", status: "fail" },
	]);
});
