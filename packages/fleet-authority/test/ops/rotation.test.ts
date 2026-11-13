// Rotation is safe to interrupt at any step (§6.16): a crash at any secret
// write, the witness down, or NATS down, then a second call, finishes the
// rotation with no refused request and a working system.
import type { SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { rotateKey } from "../../src/ops/index.js";
import { type Reached, rotate } from "../../src/ops/rotation.js";
import { readSlot, rotationName } from "../../src/ops/slots.js";
import {
	ALL_KEYS,
	type RotationSetup,
	rotateWhileRefreshing,
	rotationSetup,
} from "./rotation-setup.js";
import { opsFixture } from "./support.js";

const GRACE_MS = 2 * 60_000;

/** A secret store whose `put` number `failAt` (counting from 1) throws, as a crash mid-step would. */
function interrupting(failAt: number) {
	let puts = 0;
	return {
		count: () => puts,
		wrap(inner: SecretsPort): SecretsPort {
			return {
				id: inner.id,
				kind: inner.kind,
				async put(name, value) {
					puts += 1;
					if (puts === failAt) throw new Error(`interrupted at write ${puts}`);
					return inner.put(name, value);
				},
				access: (name) => inner.access(name),
				accessVersion: (name, version) => inner.accessVersion(name, version),
				listVersions: (name) => inner.listVersions(name),
			};
		},
	};
}

function rotateOnce(setup: RotationSetup, which: (typeof ALL_KEYS)[number]) {
	return async (): Promise<Reached> => {
		try {
			const result = await rotate(
				{ ...setup.deps(), graceMs: GRACE_MS },
				which,
			);
			if (!result.ok) throw new Error(result.error.message);
			return result.value.reached;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("interrupted"))
				return "add";
			throw error;
		}
	};
}

describe("rotateKey interrupted at every step", () => {
	it.each(
		ALL_KEYS,
	)("%s: a crash at any secret write, then resuming, finishes with no refused request", async (which) => {
		const counting = interrupting(0);
		const clean = await rotationSetup({ secrets: counting.wrap });
		try {
			await rotateWhileRefreshing(clean, which, rotateOnce(clean, which));
		} finally {
			await clean.dep.stop();
		}
		const writes = counting.count();
		expect(writes).toBeGreaterThanOrEqual(4);

		for (let failAt = 1; failAt <= writes; failAt += 1) {
			const flaky = interrupting(failAt);
			const setup = await rotationSetup({ secrets: flaky.wrap });
			try {
				const reached = await rotateWhileRefreshing(
					setup,
					which,
					rotateOnce(setup, which),
				);
				expect(reached.at(-1), `crash at write ${failAt}`).toBe("done");
				expect(setup.dev.refusals, `crash at write ${failAt}`).toEqual([]);
				if (which !== "token-signing") {
					const slot = await readSlot(
						setup.fixture.secrets,
						setup.fixture.prefix,
						which,
					);
					expect(slot.ok && slot.value?.keys.length).toBe(1);
				}
			} finally {
				await setup.dep.stop();
			}
		}
	}, 120_000);
});

describe("rotateKey waits instead of failing", () => {
	it("stops at add while the witness is down, and continues once it is back", async () => {
		const setup = await rotationSetup();
		try {
			await setup.dep.witness.stop();
			const first = await rotate(setup.deps(200), "record-signing");
			expect(first.ok && first.value.reached).toBe("add");
			setup.dep.witness.start();
			const reached = await rotateWhileRefreshing(
				setup,
				"record-signing",
				rotateOnce(setup, "record-signing"),
			);
			expect(reached.at(-1)).toBe("done");
			expect(setup.dev.refusals).toEqual([]);
		} finally {
			await setup.dep.stop();
		}
	});

	it("stops at add while NATS is down, and continues once it is back", async () => {
		const setup = await rotationSetup();
		try {
			setup.nats.setDown(true);
			const first = await rotate(setup.deps(), "scoped-executor");
			expect(first.ok && first.value.reached).toBe("add");
			const again = await rotate(setup.deps(), "scoped-executor");
			expect(again.ok && again.value.reached).toBe("add");
			setup.nats.setDown(false);
			const reached = await rotateWhileRefreshing(
				setup,
				"scoped-executor",
				rotateOnce(setup, "scoped-executor"),
			);
			expect(reached.at(-1)).toBe("done");
			expect(setup.dev.refusals).toEqual([]);
		} finally {
			await setup.dep.stop();
		}
	});

	it("stops at switch until the grace period has passed", async () => {
		const setup = await rotationSetup();
		try {
			const first = await rotate(setup.deps(), "witness");
			expect(first.ok && first.value.reached).toBe("switch");
			const early = await rotate(setup.deps(), "witness");
			expect(early.ok && early.value.reached).toBe("switch");
			setup.fixture.clock.advance(30 * 60_000);
			await setup.dep.witnessKey.refresh();
			const late = await rotate(setup.deps(), "witness");
			expect(late.ok && late.value.reached).toBe("done");
			const progress = await setup.fixture.secrets.access(
				rotationName(setup.fixture.prefix, "witness"),
			);
			expect(progress.status === "ok" && progress.material).toContain('"done"');
		} finally {
			await setup.dep.stop();
		}
	});
});

describe("rotateKey refusals", () => {
	it("refuses a key that was never provisioned", async () => {
		const fixture = await opsFixture();
		const setup = await rotationSetup();
		try {
			const result = await rotate(
				{ ...setup.deps(), secrets: fixture.secrets },
				"account-signing",
			);
			expect(result.ok ? "" : result.error.code).toBe("invalid-request");
		} finally {
			await setup.dep.stop();
		}
	});

	it("answers an outcome, not a throw, when the deployment cannot be reached", async () => {
		const fixture = await opsFixture({
			natsUrls: ["nats://127.0.0.1:1"],
		});
		await fixture.secrets.put(`${fixture.prefix}/nats-authority`, "");
		const result = await rotateKey(fixture.context, "witness");
		expect(result.ok).toBe(false);
	});
});
