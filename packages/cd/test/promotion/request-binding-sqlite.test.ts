import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { PROMOTION_REASON } from "../../src/promotion/index.js";
import { resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid } from "./store.js";

it("preserves promotion and rollback request bindings through SQLite reopen", async () => {
	const dir = mkdtempSync(join(tmpdir(), "hobo-promotion-binding-"));
	const h = harness();
	h.freight.add("f0");
	h.freight.add("f1");
	h.desired.seed("dev-1", "f0", resolvedFor("dev-1", "alpha", "f0"));
	const request = {
		freightId: fid("f1"),
		targets: [camp("dev-1")],
		idempotencyKey: "durable-promotion",
	};
	const rollback = {
		campId: camp("dev-1"),
		reason: "restore",
		idempotencyKey: "durable-rollback",
	};
	let store = createRuntimeLocalEventStore({ dataDir: dir });
	try {
		const service = h.withStore(store);
		const promoted = await service.promote(request, h.ctx());
		expect(promoted.ok).toBe(true);
		const rolled = await service.rollback(rollback, h.ctx());
		expect(rolled.ok).toBe(true);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: dir });
		const reopened = h.withStore(store);
		expect((await reopened.promote(request, h.ctx())).ok).toBe(true);
		expect((await reopened.rollback(rollback, h.ctx())).ok).toBe(true);
		const changedPromotion = await reopened.promote(
			{ ...request, intent: "up" },
			h.ctx(),
		);
		const changedRollback = await reopened.rollback(
			{ ...rollback, reason: "other" },
			h.ctx(),
		);
		for (const result of [changedPromotion, changedRollback]) {
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.reasons[0]?.code).toBe(
					PROMOTION_REASON.idempotencyReused,
				);
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
