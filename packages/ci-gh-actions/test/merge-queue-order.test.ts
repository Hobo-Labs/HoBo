import { describe, expect, it, vi } from "vitest";
import {
	createMergeQueuePositionCache,
	fetchMergeQueuePositions,
} from "../src/merge-queue-order.js";
import type { GithubTransport } from "../src/github.js";

describe("merge queue positions", () => {
	it("maps head sha to queue position from GraphQL", async () => {
		const github: GithubTransport = {
			request: vi.fn(async () =>
				Response.json({
					data: {
						repository: {
							mergeQueue: {
								entries: {
									nodes: [
										{
											position: 1,
											headCommit: { oid: "a".repeat(40) },
										},
										{
											position: 2,
											headCommit: { oid: "b".repeat(40) },
										},
									],
								},
							},
						},
					},
				}),
			),
		};
		const snapshot = await fetchMergeQueuePositions(
			github,
			1,
			"Hobo-Labs",
			"Hobo-Labs/HoBo",
			"main",
		);
		expect(snapshot?.byHeadSha.get("a".repeat(40))).toBe(1);
		expect(snapshot?.byHeadSha.get("b".repeat(40))).toBe(2);
	});

	it("refreshes the cache from the primary connection", async () => {
		const github: GithubTransport = {
			request: vi.fn(async () =>
				Response.json({
					data: {
						repository: {
							mergeQueue: {
								entries: {
									nodes: [
										{ position: 1, headCommit: { oid: "c".repeat(40) } },
									],
								},
							},
						},
					},
				}),
			),
		};
		const cache = createMergeQueuePositionCache({
			github,
			branch: "main",
			connections: async () => [
				{ installationId: 9, repository: "Hobo-Labs/HoBo" },
			],
		});
		await cache.refresh();
		expect(cache.snapshot()?.byHeadSha.get("c".repeat(40))).toBe(1);
	});
});
