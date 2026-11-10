import { describe, expect, it } from "vitest";
import {
	accountForStorageOverflowReserve,
	selectStorageSpillBackend,
} from "../src/isolated-worker/fleet-storage-spill.js";
import { create } from "@bufbuild/protobuf";
import { AccountSchema, JobSchema, OfferSchema } from "@hobo/ci";

function accountWithOverflow() {
	return create(AccountSchema, {
		id: "hobo-labs",
		offers: [
			create(OfferSchema, {
				id: "box",
				provider: "hobo-box-worker",
				providerAccountId: "oracle-free-vm",
				enabled: true,
				concurrency: 2,
				runsOn: "hobo-isolated-worker",
				backend: "isolated-container",
				priceMicrosPerMinute: 0,
				validUntil: new Date(Date.now() + 86_400_000).toISOString(),
				observedAt: "2026-11-10T00:00:00Z",
				sourceUrl: "https://example.test/box",
				bridgeAcknowledged: true,
			}),
			create(OfferSchema, {
				id: "arc",
				provider: "kubernetes",
				providerAccountId: "hostinger-arc",
				enabled: true,
				concurrency: 4,
				runsOn: "hobo-arc",
				backend: "gh-actions",
				priceMicrosPerMinute: 0,
				validUntil: new Date(Date.now() + 86_400_000).toISOString(),
				observedAt: "2026-11-10T00:00:00Z",
				sourceUrl: "https://example.test/arc",
				bridgeAcknowledged: true,
			}),
			create(OfferSchema, {
				id: "gh",
				provider: "github",
				providerAccountId: "github-hosted",
				enabled: true,
				concurrency: 10,
				runsOn: "ubuntu-24.04",
				backend: "gh-actions",
				priceMicrosPerMinute: 0,
				validUntil: new Date(Date.now() + 86_400_000).toISOString(),
				observedAt: "2026-11-10T00:00:00Z",
				sourceUrl: "https://example.test/gh",
				bridgeAcknowledged: true,
			}),
		],
	});
}

describe("fleet storage spill", () => {
	it("selects ARC or GitHub when hobo storage slots are zero", () => {
		const account = accountWithOverflow();
		const job = create(JobSchema, {
			id: 1,
			runId: 9,
			runAttempt: 1,
			repositoryId: 1,
			repository: "Org/Repo",
			installationId: 1,
			name: "PR impact gate",
			labels: ["hobo"],
			isolatedRequired: false,
		});
		const spill = selectStorageSpillBackend(account, job, 0);
		expect(spill?.backend).toBe("arc");
		const overflowAccount = accountForStorageOverflowReserve(account);
		const box = overflowAccount.offers.find((o) => o.provider === "hobo-box-worker");
		expect(box?.enabled).toBe(false);
		expect(overflowAccount.offers.some((o) => o.enabled && o.id === "arc")).toBe(
			true,
		);
	});
});
