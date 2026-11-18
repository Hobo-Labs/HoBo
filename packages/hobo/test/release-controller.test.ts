import { describe, expect, it } from "vitest";
import {
	promoteVerifiedRelease,
	type ReleaseCheckpoint,
	type ReleaseJournal,
	type ReleaseProvider,
} from "../src/release-controller.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fixture() {
	let time = 0;
	let current = "old";
	let checkpoint: ReleaseCheckpoint | undefined;
	let healthy = true;
	let staged = true;
	let replaceDuringProbe = false;
	let throwAfterPromote = false;
	let delayedPromotion = false;
	let promotionDelay = 20;
	let delayedRollback = false;
	let promotionAt: number | undefined;
	let rollbackAt: number | undefined;
	const events: string[] = [];
	const journal: ReleaseJournal = {
		async load() {
			return checkpoint;
		},
		async reserve(value) {
			if (checkpoint === undefined) {
				events.push("journal:reserved");
				checkpoint = value;
				return { checkpoint, created: true };
			}
			return { checkpoint, created: false };
		},
		async save(value) {
			events.push(`journal:${value.state}`);
			checkpoint = value;
		},
	};
	const provider: ReleaseProvider = {
		async canRollback() {
			return true;
		},
		async inspect(deploymentId) {
			return { deploymentId, commit: COMMIT, ready: true, staged };
		},
		async current() {
			if (promotionAt !== undefined && time >= promotionAt) {
				current = "new";
				promotionAt = undefined;
			}
			if (rollbackAt !== undefined && time >= rollbackAt) {
				current = "old";
				rollbackAt = undefined;
			}
			return current;
		},
		async promote(deploymentId) {
			events.push(`promote:${deploymentId}`);
			if (delayedPromotion) {
				promotionAt = time + promotionDelay;
				throw new Error("answer lost before alias changed");
			}
			current = deploymentId;
			if (throwAfterPromote) throw new Error("answer lost");
			return "settled";
		},
		async rollback(deploymentId) {
			events.push(`rollback:${deploymentId}`);
			if (delayedRollback) {
				rollbackAt = time + 20;
				return "pending";
			}
			current = deploymentId;
			return "settled";
		},
		async probe() {
			events.push("probe");
			if (replaceDuringProbe) current = "operator-release";
			return healthy;
		},
	};
	return {
		events,
		provider,
		journal,
		current: () => current,
		checkpoint: () => checkpoint,
		setCheckpoint(value: ReleaseCheckpoint) {
			checkpoint = value;
		},
		setCurrent(value: string) {
			current = value;
		},
		setHealthy(value: boolean) {
			healthy = value;
		},
		setStaged(value: boolean) {
			staged = value;
		},
		replaceDuringProbe() {
			replaceDuringProbe = true;
		},
		throwAfterPromote() {
			throwAfterPromote = true;
		},
		delayPromotion(delay = 20) {
			delayedPromotion = true;
			promotionDelay = delay;
		},
		advanceTime(ms: number) {
			time += ms;
		},
		delayRollback() {
			delayedRollback = true;
		},
		run: () =>
			promoteVerifiedRelease({
				provider,
				journal,
				deploymentId: "new",
				commit: COMMIT,
				deadline: 50,
				rollbackDeadline: 80,
				now: () => time,
				sleep: async (ms) => {
					time += ms;
				},
				intervalMs: 10,
			}),
	};
}

describe("verified release", () => {
	it("reserves the previous deployment before promoting and qualifying healthy production", async () => {
		const f = fixture();
		expect(await f.run()).toEqual({ ok: true, previousDeploymentId: "old" });
		expect(f.events).toEqual([
			"journal:reserved",
			"promote:new",
			"probe",
			"probe",
			"probe",
			"journal:verified",
		]);
		expect(f.current()).toBe("new");
	});

	it("rolls back a candidate that fails the public health checks", async () => {
		const f = fixture();
		f.setHealthy(false);
		expect(await f.run()).toEqual({
			ok: false,
			code: "verification-failed",
			rolledBack: true,
		});
		expect(f.current()).toBe("old");
		expect(f.checkpoint()?.state).toBe("rolled-back");
	});

	it("does not knowingly overwrite a concurrent operator deployment", async () => {
		const f = fixture();
		f.replaceDuringProbe();
		expect(await f.run()).toEqual({
			ok: false,
			code: "concurrent-change",
			rolledBack: false,
		});
		expect(f.current()).toBe("operator-release");
		expect(f.events.some((event) => event.startsWith("rollback:"))).toBe(false);
	});

	it("keeps a lost promotion response reserved even when the alias changed", async () => {
		const f = fixture();
		f.throwAfterPromote();
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.current()).toBe("new");
		expect(f.checkpoint()?.state).toBe("reserved");
		expect(f.events).not.toContain("rollback:old");
	});

	it("does not roll back after a lost response before a delayed promotion", async () => {
		const f = fixture();
		f.delayPromotion();
		f.delayRollback();
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.current()).toBe("old");
		expect(f.checkpoint()?.state).toBe("reserved");
		f.advanceTime(20);
		expect(await f.provider.current()).toBe("new");
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.events).not.toContain("rollback:old");
	});

	it("retains the reservation while a rollback remains pending", async () => {
		const f = fixture();
		f.setHealthy(false);
		f.delayRollback();
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.checkpoint()?.state).toBe("reserved");
	});

	it("does not roll back after the verified checkpoint acknowledgement is lost", async () => {
		const f = fixture();
		const journal: ReleaseJournal = {
			...f.journal,
			async save(value) {
				await f.journal.save(value);
				throw new Error("reply lost");
			},
		};
		let time = 0;
		expect(
			await promoteVerifiedRelease({
				provider: f.provider,
				journal,
				deploymentId: "new",
				commit: COMMIT,
				deadline: 50,
				now: () => time,
				sleep: async (ms) => {
					time += ms;
				},
				intervalMs: 10,
			}),
		).toEqual({ ok: false, code: "journal-failed", rolledBack: false });
		expect(f.checkpoint()?.state).toBe("verified");
		expect(f.current()).toBe("new");
		expect(f.events).not.toContain("rollback:old");
	});

	it("keeps an interrupted reservation when the old deployment is still serving", async () => {
		const f = fixture();
		f.setCheckpoint({
			deploymentId: "new",
			previousDeploymentId: "old",
			commit: COMMIT,
			state: "reserved",
		});
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.checkpoint()?.state).toBe("reserved");
		expect(f.events).not.toContain("promote:new");
		expect(f.events).not.toContain("rollback:old");
	});

	it("retains an uncertain checkpoint when a promotion may arrive after the deadline", async () => {
		const f = fixture();
		f.delayPromotion(100);
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.checkpoint()?.state).toBe("reserved");
		f.advanceTime(100);
		expect(await f.provider.current()).toBe("new");
		expect(f.events.filter((event) => event === "promote:new")).toHaveLength(1);
	});

	it("does not promote a reservation created after its initial read", async () => {
		const f = fixture();
		await f.journal.reserve({
			deploymentId: "new",
			previousDeploymentId: "old",
			commit: COMMIT,
			state: "reserved",
		});
		const journal: ReleaseJournal = {
			...f.journal,
			async load() {
				return undefined;
			},
		};
		let time = 0;
		expect(
			await promoteVerifiedRelease({
				provider: f.provider,
				journal,
				deploymentId: "new",
				commit: COMMIT,
				deadline: 50,
				now: () => time,
				sleep: async (ms) => {
					time += ms;
				},
				intervalMs: 10,
			}),
		).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.events).not.toContain("promote:new");
		expect(f.checkpoint()?.state).toBe("reserved");
	});

	it("keeps an interrupted promotion reserved even when the alias changed", async () => {
		const f = fixture();
		f.setCheckpoint({
			deploymentId: "new",
			previousDeploymentId: "old",
			commit: COMMIT,
			state: "reserved",
		});
		f.setCurrent("new");
		expect(await f.run()).toEqual({
			ok: false,
			code: "promotion-uncertain",
			rolledBack: false,
		});
		expect(f.events).not.toContain("promote:new");
		expect(f.events).not.toContain("rollback:old");
		expect(f.checkpoint()?.state).toBe("reserved");
	});

	it("refuses an unstaged candidate before any journal or provider mutation", async () => {
		const f = fixture();
		f.setStaged(false);
		expect(await f.run()).toEqual({
			ok: false,
			code: "candidate-invalid",
			rolledBack: false,
		});
		expect(f.events).toEqual([]);
	});
});
