import { DURABLE_MESSAGING_CONFORMANCE_CASES } from "@hobo/conformance";
import { durableMessagingOperation } from "@hobo/core";
import { expect, it } from "vitest";
import { createRivetDurableTopicClient } from "../src/durable-topic-client.js";
import { createSqliteBusConformanceHost } from "./fixtures/durable-topic-bus-conformance.js";
import { runRivetMessagingConformance } from "./fixtures/durable-topic-conformance.js";

it("runs supported generic cases against the real bus actor and SQLite", {
	timeout: 120_000,
}, async () => {
	const supported = new Set([
		"group-isolation",
		"lease-receipt-replay",
		"expiry-boundary",
		"revoked-receipt-privacy",
		"pending-conflict",
		"detached-requests",
		"fingerprint-fields",
		"tenant-isolation",
		"bounds",
	]);
	const results = [];
	for (const name of DURABLE_MESSAGING_CONFORMANCE_CASES) {
		const report = await runRivetMessagingConformance(
			async () => {
				if (!supported.has(name))
					throw new Error("required host control or profile unavailable");
				return createSqliteBusConformanceHost();
			},
			{ case: name, caseTimeoutMs: 15_000 },
		);
		expect(
			Object.values(report.executionEvidence).every(
				(value) => value === "unverified",
			),
		).toBe(true);
		results.push(...report.cases);
	}
	console.log("SQLite bus generic conformance:", JSON.stringify(results));
	expect(results).toHaveLength(DURABLE_MESSAGING_CONFORMANCE_CASES.length);
	expect(results.filter((result) => result.status === "fail")).toEqual([]);
	expect(
		results
			.filter((result) => result.status === "pass")
			.map(({ name }) => name),
	).toEqual([
		"group-isolation",
		"lease-receipt-replay",
		"expiry-boundary",
		"revoked-receipt-privacy",
		"pending-conflict",
		"detached-requests",
		"fingerprint-fields",
		"tenant-isolation",
		"bounds",
	]);
	expect(results.filter((result) => result.status === "unknown")).toHaveLength(
		DURABLE_MESSAGING_CONFORMANCE_CASES.length - 9,
	);
});

it("shares one initialized actor store across concurrent opens for the same tenant", async () => {
	const host = await createSqliteBusConformanceHost();
	try {
		const [left, right] = await Promise.all([
			host.open("tenant-a"),
			host.open("tenant-a"),
		]);
		const first = createRivetDurableTopicClient(left);
		const second = createRivetDurableTopicClient(right);
		expect(
			await first.ensureTopic({
				operation: durableMessagingOperation(10_000, "0000000000000001"),
				topic: "shared",
			}),
		).toEqual({ status: "committed", value: { topic: "shared" } });
		expect(await second.events({ afterSequence: 0, limit: 1 })).toMatchObject({
			status: "ok",
			events: [{ sequence: 1, kind: "topic-created", topic: "shared" }],
		});
	} finally {
		await host.controls.close();
	}
});
