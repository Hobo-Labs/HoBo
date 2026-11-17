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
			}
			return checkpoint;
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
				promotionAt = time + 20;
				throw new Error("answer lost before alias changed");
			}
			current = deploymentId;
			if (throwAfterPromote) throw new Error("answer lost");
		},
		async rollback(deploymentId) {
			events.push(`rollback:${deploymentId}`);
			if (delayedRollback) {
				rollbackAt = time + 20;
				return;
			}
			current = deploymentId;
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
		delayPromotion() {
			delayedPromotion = true;
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

	it("recovers a lost promotion response using the reserved previous deployment", async () => {
		const f = fixture();
		f.throwAfterPromote();
		expect(await f.run()).toEqual({
			ok: false,
			code: "promote-failed",
			rolledBack: true,
		});
		expect(f.current()).toBe("old");
	});

	it("observes a delayed promotion after a lost response and confirms a delayed rollback", async () => {
		const f = fixture();
		f.delayPromotion();
		f.delayRollback();
		expect(await f.run()).toEqual({
			ok: false,
			code: "promote-failed",
			rolledBack: true,
		});
		expect(f.current()).toBe("old");
		expect(f.checkpoint()?.state).toBe("rolled-back");
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
			code: "verification-failed",
			rolledBack: false,
		});
		expect(f.checkpoint()?.state).toBe("reserved");
		expect(f.events).not.toContain("promote:new");
		expect(f.events).not.toContain("rollback:old");
	});

	it("resumes an interrupted promotion and does not repeat a completed release after a manual rollback", async () => {
		const f = fixture();
		f.setCheckpoint({
			deploymentId: "new",
			previousDeploymentId: "old",
			commit: COMMIT,
			state: "reserved",
		});
		f.setCurrent("new");
		expect((await f.run()).ok).toBe(true);
		expect(f.events).not.toContain("promote:new");
		f.setCurrent("old");
		expect(await f.run()).toEqual({
			ok: false,
			code: "concurrent-change",
			rolledBack: false,
		});
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
