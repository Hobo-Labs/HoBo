/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: CampId literal cast once for fixture report. */
import type { CdPassReport } from "@hobo/hobo/cd-platform";
import { describe, expect, it } from "vitest";

import { CdStoreBindingError } from "../src/index.js";
import { runTick } from "../src/tick.js";

const capture = () => {
	const lines: string[] = [];
	return {
		lines,
		write: (line: string) => {
			lines.push(line);
		},
	};
};

const okReport: CdPassReport = Object.freeze({
	tick: Object.freeze({ atMs: 0, store: true, steps: Object.freeze([]) }),
	reconciled: Object.freeze([
		Object.freeze({ campId: "edge/prod" as never, ok: true, detail: "" }),
	]),
	skipped: false,
});

describe("runTick", () => {
	it("skips an unset VERCEL_ENV, even with the allowance flag set", async () => {
		const { lines, write } = capture();
		await runTick({
			env: { HOBO_CD_ALLOW_UNSET_VERCEL_ENV: "1" },
			write,
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "cd.pass.skipped",
			reason: "cd-non-production-deployment",
		});
	});

	it("skips a preview deployment, even with the allowance flag set", async () => {
		const { lines, write } = capture();
		await runTick({
			env: {
				VERCEL_ENV: "preview",
				HOBO_CD_ALLOW_UNSET_VERCEL_ENV: "1",
			},
			write,
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "cd.pass.skipped",
			reason: "cd-non-production-deployment",
		});
	});

	it("acks a permanent store-binding refusal without a pass", async () => {
		const { lines, write } = capture();
		await runTick({
			env: { VERCEL_ENV: "production" },
			runPass: async () => {
				throw new CdStoreBindingError("cd-journal-not-provisioned", "no fleet");
			},
			write,
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "cd.pass.refused",
			reason: "cd-journal-not-provisioned",
		});
	});

	it("propagates a transient pass failure for redelivery", async () => {
		const { lines, write } = capture();
		const transient = Object.assign(new Error("journal append refused"), {
			code: "cd-host-pass-record-failed",
		});
		await expect(
			runTick({
				env: { VERCEL_ENV: "production" },
				runPass: async () => {
					throw transient;
				},
				write,
			}),
		).rejects.toBe(transient);
		expect(lines).toEqual([]);
	});

	it("logs a completed pass", async () => {
		const { lines, write } = capture();
		await runTick({
			env: { VERCEL_ENV: "production" },
			runPass: async () => okReport,
			write,
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "cd.pass",
			camps: 1,
			store: true,
		});
	});

	it("logs a skipped pass with its lease reason", async () => {
		const { lines, write } = capture();
		await runTick({
			env: { VERCEL_ENV: "production" },
			runPass: async () =>
				Object.freeze({
					...okReport,
					reconciled: Object.freeze([]),
					skipped: true,
					skipReason: "fleet-pass-lease-held",
				}),
			write,
		});
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			event: "cd.pass.skipped",
			reason: "fleet-pass-lease-held",
		});
	});
});
