import { describe, expect, it, vi } from "vitest";

import { neonJournalProvisioner } from "../src/cd-journal-provisioners.js";

describe("the CD journal provisioner", () => {
	it("does not create an anonymous database without a durable atomic claim", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const provisioner = neonJournalProvisioner(fetch);
		const attempts = await Promise.allSettled([
			provisioner.create({
				member: "journal-1",
				idempotencyKey: "hobo-cd-journal:journal-1",
			}),
			provisioner.create({
				member: "journal-1",
				idempotencyKey: "hobo-cd-journal:journal-1",
			}),
		]);
		for (const result of attempts) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(String(result.reason)).toMatch(/durable.*atomic/i);
		}
		expect(fetch).not.toHaveBeenCalled();
	});
});
