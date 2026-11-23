import { describe, expect, it } from "vitest";

import {
	AutoscalingRunnerSetSchema,
	arcRunnerCachePatch,
	latestStorePrewarm,
	STORE_PREWARM_LABEL,
	STORE_PREWARM_REF_LABEL,
	StorePrewarmJobListSchema,
	storePrewarmJob,
	storePrewarmJobName,
	withRunnerCaches,
} from "../src/arc-runner-caches.js";

const SHA = "4da35cfd92854b07ea368680fcc19a621faa928f";
const OLDER = "0123456789abcdef0123456789abcdef01234567";

const set = AutoscalingRunnerSetSchema.parse({
	metadata: {
		name: "hobo-trunk",
		namespace: "arc-runners",
		resourceVersion: "918273",
	},
	spec: {
		template: {
			spec: {
				containers: [
					{ name: "runner", image: "ghcr.io/actions/actions-runner:2.329.0" },
				],
			},
		},
	},
});

function job(
	ref: string,
	created: string,
	status: Readonly<Record<string, number | readonly object[]>>,
) {
	return {
		metadata: {
			name: `hobo-trunk-store-prewarm-${ref.slice(0, 12)}`,
			creationTimestamp: created,
			labels: {
				[STORE_PREWARM_LABEL]: "hobo-trunk",
				[STORE_PREWARM_REF_LABEL]: ref,
			},
		},
		spec: { backoffLimit: 2 },
		status,
	};
}

describe("ARC runner caches", () => {
	it("labels the prewarm Job with its scale set and commit, and keeps it after it finishes", () => {
		const built = storePrewarmJob(set, "Hobo-Labs/HoBo", SHA);
		expect(built.metadata).toEqual({
			name: storePrewarmJobName(set, SHA),
			namespace: "arc-runners",
			labels: {
				[STORE_PREWARM_LABEL]: "hobo-trunk",
				[STORE_PREWARM_REF_LABEL]: SHA,
			},
		});
		expect(built.spec).not.toHaveProperty("ttlSecondsAfterFinished");
	});

	it("reads the newest prewarm Job's outcome", () => {
		const observe = (items: readonly object[]) =>
			latestStorePrewarm(StorePrewarmJobListSchema.parse({ items }));
		expect(observe([])).toBeUndefined();
		expect(
			observe([
				job(OLDER, "2026-11-20T08:00:00Z", { failed: 3 }),
				job(SHA, "2026-11-23T18:00:00Z", {
					succeeded: 1,
					conditions: [{ type: "Complete", status: "True" }],
				}),
			]),
		).toEqual({
			job: storePrewarmJobName(set, SHA),
			ref: SHA,
			state: "succeeded",
		});
		expect(
			observe([job(SHA, "2026-11-23T18:00:00Z", { failed: 3 })])?.state,
		).toBe("failed");
		expect(
			observe([
				job(SHA, "2026-11-23T18:00:00Z", {
					conditions: [{ type: "Failed", status: "True" }],
				}),
			])?.state,
		).toBe("failed");
		expect(
			observe([job(SHA, "2026-11-23T18:00:00Z", { active: 1, failed: 1 })])
				?.state,
		).toBe("running");
	});

	it("plans nothing once the caches are in the template", () => {
		expect(arcRunnerCachePatch(set)).toHaveLength(4);
		expect(arcRunnerCachePatch(withRunnerCaches(set))).toEqual([]);
	});
});
