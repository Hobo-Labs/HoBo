import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTurboInvoke } from "../ci/turbo-invoke.mts";

describe("turbo-invoke", () => {
	it("uses mise for install-free planners", () => {
		const prior = process.env.HOBO_TURBO_INVOKER;
		process.env.HOBO_TURBO_INVOKER = "mise";
		try {
			assert.deepEqual(resolveTurboInvoke(), {
				command: "mise",
				prefix: ["exec", "--", "turbo"],
			});
		} finally {
			if (prior === undefined) delete process.env.HOBO_TURBO_INVOKER;
			else process.env.HOBO_TURBO_INVOKER = prior;
		}
	});

	it("defaults to pnpm exec turbo in full jobs", () => {
		const prior = process.env.HOBO_TURBO_INVOKER;
		delete process.env.HOBO_TURBO_INVOKER;
		try {
			assert.deepEqual(resolveTurboInvoke(), {
				command: "pnpm",
				prefix: ["exec", "turbo"],
			});
		} finally {
			if (prior === undefined) delete process.env.HOBO_TURBO_INVOKER;
			else process.env.HOBO_TURBO_INVOKER = prior;
		}
	});
});
